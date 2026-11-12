/*
 * main.c — AgentDock: pi coding agent 专用控制器 (M2)
 *
 * 设备专用化: BLE 上只有 AgentDock 自定义 GATT 服务, 唯一对端是 pi 扩展.
 *   - 扩展已连接 → 按键/旋钮事件经通道上报, 由 pi API 执行 (不依赖窗口焦点)
 *   - 未连接     → 输入无动作, LED 心跳显示待命
 *
 * 按键语义 (事件 JSON 见 deck.c / 扩展 README):
 *   KEY1 短按   → 打断 agent (pi.abort)
 *   KEY1 长按   → 静音切换 (NVS 持久化, 本地音效)
 *   KEY2 短按   → 宏「继续」
 *   KEY2 长按   → 演示模式: 魂斗罗旋律 + 七彩呼吸灯 (3s)
 *   KEY3 短按   → 「继续」
 *   KEY3 长按   → 旋钮刻度音开关 (NVS 持久化)
 *   旋钮旋转    → 滚动 agent 输出 (本地齿轮声, 顺时针升调/逆时针降调)
 *   旋钮按压    → 「继续」
 *
 * 数据流: input 任务 → 事件队列 → app 任务分发 (deck / fx / config)
 */
#include <stdio.h>

#include "esp_log.h"
#include "esp_mac.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

#include "app_events.h"
#include "config.h"
#include "deck.h"
#include "fx.h"
#include "input.h"

static const char *TAG = "main";

#define APP_QUEUE_LEN   16

static QueueHandle_t s_app_queue;
static char s_device_name[32];     /* "AgentDock-XXXX" (MAC 后 4 位) */

/* ---------------- 动作 → 事件上报 ---------------- */
static void send_key_event(int key_id)
{
    char buf[40];
    snprintf(buf, sizeof(buf), "{\"k\":\"key\",\"id\":%d}", key_id);
    deck_send_event(buf);
}

/** 把设备当前设置上报给扩展 (面板显示用; 设备 NVS 是唯一真源) */
static void send_settings_event(void)
{
    char buf[80];
    snprintf(buf, sizeof(buf), "{\"k\":\"cfg\",\"b\":%u,\"v\":%u,\"m\":%d,\"c\":%d}",
             fx_get_brightness(), fx_get_volume(),
             fx_is_muted() ? 1 : 0, fx_is_click_enabled() ? 1 : 0);
    deck_send_event(buf);
}

static void handle_event(const input_event_t *ev)
{
    switch (ev->type) {
    case IN_EVT_KEY_SHORT:
        switch (ev->value) {
        case KEY_ID_1:
            ESP_LOGI(TAG, "动作: 打断 agent");
            fx_play(FX_CONFIRM);
            send_key_event(1);
            break;
        case KEY_ID_2:
            ESP_LOGI(TAG, "动作: 宏「继续」");
            fx_play(FX_CONFIRM);
            send_key_event(2);
            break;
        case KEY_ID_3:
            ESP_LOGI(TAG, "动作: 继续");
            fx_play(FX_CONFIRM);
            send_key_event(3);
            break;
        case KEY_ID_ENC_SW:
            ESP_LOGI(TAG, "动作: 旋钮按压=继续");
            fx_play(FX_CONFIRM);
            send_key_event(4);
            break;
        default:
            break;
        }
        break;

    case IN_EVT_KEY_LONG:
        switch (ev->value) {
        case KEY_ID_1: {   /* 静音 */
            const bool muted = !fx_is_muted();
            fx_set_muted(muted);
            ESP_LOGI(TAG, "动作: 静音 → %s", muted ? "开" : "关");
            fx_play(muted ? FX_MUTED_ON : FX_MUTED_OFF);
            break;
        }
        case KEY_ID_2:     /* 演示: 魂斗罗 + 七彩呼吸 (本地反馈, 不依赖连接) */
            ESP_LOGI(TAG, "动作: 演示模式");
            fx_demo_start();
            break;
        case KEY_ID_3: {   /* 旋钮刻度音开关 */
            const bool on = !fx_is_click_enabled();
            fx_set_click_enabled(on);
            ESP_LOGI(TAG, "动作: 旋钮刻度音 → %s", on ? "开" : "关");
            fx_play(on ? FX_MUTED_ON : FX_MUTED_OFF);
            break;
        }
        default:
            break;
        }
        break;

    case IN_EVT_ENC_STEP: {
        ESP_LOGD(TAG, "动作: 滚动 %+ld", (long)ev->value);
        fx_encoder_click(ev->value);   /* 本地刻度音: 顺/逆时针音高不同 */
        char buf[40];
        snprintf(buf, sizeof(buf), "{\"k\":\"enc\",\"v\":%ld}", (long)ev->value);
        deck_send_event(buf);
        break;
    }

    default:
        break;
    }
}

static void app_task(void *arg)
{
    input_event_t ev;
    for (;;) {
        if (xQueueReceive(s_app_queue, &ev, portMAX_DELAY) == pdTRUE) {
            ESP_LOGD(TAG, "事件 %s/%ld", input_type_name(ev.type), (long)ev.value);
            handle_event(&ev);
        }
    }
}

/* GATT 通道激活/断开 → 灯效切换 */
static void on_deck_channel(bool active)
{
    if (active) {
        fx_play(FX_CONFIRM);
        fx_set_agent_state(DECK_STATE_IDLE);   /* 真实状态由扩展补推 */
        send_settings_event();                 /* 把亮度/音量/静音交给面板显示 */
    } else {
        fx_set_offline();
    }
}

static void app_init_nvs(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
}

/* BLE 名 = "AgentDock-" + MAC 后 4 位 hex, 多设备不冲突 */
static void make_device_name(void)
{
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(s_device_name, sizeof(s_device_name), "AgentDock-%02X%02X", mac[4], mac[5]);
}

void app_main(void)
{
    ESP_LOGI(TAG, "===== AgentDock 启动 =====");

    app_init_nvs();
    config_init();   /* 配置先于 fx: 音量/亮度在第一个音符/第一帧 LED 前就位 */

    /* fx 先于其它模块: 启动音效/静音状态立即可用 */
    fx_init();

    make_device_name();

    s_app_queue = xQueueCreate(APP_QUEUE_LEN, sizeof(input_event_t));
    input_start(s_app_queue);
    xTaskCreate(app_task, "app", 4096, NULL, 8, NULL);

    deck_init(s_device_name);
    deck_set_channel_cb(on_deck_channel);

    fx_play(FX_BOOT);
    ESP_LOGI(TAG, "启动完成, 等待 pi 扩展连接: %s", s_device_name);
}

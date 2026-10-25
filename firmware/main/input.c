/*
 * input.c — 按键/旋钮扫描实现
 *
 * 轮询架构 (而非 GPIO 中断) 的理由:
 *   - 引脚少(6), 1ms 轮询 CPU 占用可忽略
 *   - 消抖/长按/正交解码在同一时间线上, 逻辑集中无竞态
 *   - C2 无 RMT/PCNT 等硬件辅助, 中断方案反而引入复杂度
 */
#include "input.h"

#include <stdbool.h>
#include <stdint.h>

#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/task.h"

static const char *TAG = "input";

#define DEBOUNCE_MS       20
#define POLL_PERIOD_MS    1

/* ---------------- 按键状态机 ---------------- */
typedef struct {
    int pin;
    key_id_t id;
    const char *name;
    bool pressed;        /* 稳定态: true=按下 (低电平) */
    bool last_raw;       /* 上次原始电平 (true=按下) */
    int64_t pressed_at;  /* 本次按下的时刻 us */
    int64_t stable_at;   /* 电平稳定时刻 us, 用于消抖 */
} key_state_t;

static key_state_t s_keys[] = {
    { INPUT_PIN_KEY1,   KEY_ID_1,      "KEY1",   false, false, 0, 0 },
    { INPUT_PIN_KEY2,   KEY_ID_2,      "KEY2",   false, false, 0, 0 },
    { INPUT_PIN_KEY3,   KEY_ID_3,      "KEY3",   false, false, 0, 0 },
    { INPUT_PIN_ENC_SW, KEY_ID_ENC_SW, "ENC-SW", false, false, 0, 0 },
};

/* ---------------- 旋钮正交解码 ---------------- */
/* 状态转移表: index = (prev<<2)|curr, 值为步进方向 (格雷码四状态) */
static const int8_t ENC_DIR[16] = {
    0, -1, +1, 0,
    +1, 0, 0, -1,
    -1, 0, 0, +1,
    0, +1, -1, 0,
};
static int s_enc_last = 3;   /* 上电 AB 双上拉 = 11 */

/* ---------------- 内部 ---------------- */
static void keys_init(void)
{
    for (int i = 0; i < sizeof(s_keys) / sizeof(s_keys[0]); i++) {
        gpio_reset_pin(s_keys[i].pin);
        gpio_set_direction(s_keys[i].pin, GPIO_MODE_INPUT);
        gpio_set_pull_mode(s_keys[i].pin, GPIO_PULLUP_ONLY);
        s_keys[i].last_raw = gpio_get_level(s_keys[i].pin) == 0;   /* 上电即视为稳定 */
        s_keys[i].pressed = s_keys[i].last_raw;
        s_keys[i].pressed_at = 0;
        s_keys[i].stable_at = esp_timer_get_time();
    }
    gpio_reset_pin(INPUT_PIN_ENC_A);
    gpio_set_direction(INPUT_PIN_ENC_A, GPIO_MODE_INPUT);
    gpio_set_pull_mode(INPUT_PIN_ENC_A, GPIO_PULLUP_ONLY);
    gpio_reset_pin(INPUT_PIN_ENC_B);
    gpio_set_direction(INPUT_PIN_ENC_B, GPIO_MODE_INPUT);
    gpio_set_pull_mode(INPUT_PIN_ENC_B, GPIO_PULLUP_ONLY);
    s_enc_last = (gpio_get_level(INPUT_PIN_ENC_A) << 1) | gpio_get_level(INPUT_PIN_ENC_B);
    ESP_LOGI(TAG, "keys=IO%d/IO%d/IO%d/IO%d enc=IO%d/IO%d (pullup, 低电平=按下)",
             INPUT_PIN_KEY1, INPUT_PIN_KEY2, INPUT_PIN_KEY3, INPUT_PIN_ENC_SW,
             INPUT_PIN_ENC_A, INPUT_PIN_ENC_B);
}

static void emit(QueueHandle_t q, input_type_t type, int32_t value)
{
    input_event_t ev = { .type = type, .value = value };
    if (xQueueSend(q, &ev, 0) != pdTRUE) {
        ESP_LOGW(TAG, "事件队列满, 丢弃 %s/%ld", input_type_name(type), (long)value);
    }
}

/* 消抖 + 短/长按判定. 返回是否产生了按下事件. */
static void keys_poll(QueueHandle_t q)
{
    const int64_t now = esp_timer_get_time();
    for (int i = 0; i < sizeof(s_keys) / sizeof(s_keys[0]); i++) {
        key_state_t *k = &s_keys[i];
        const bool raw = gpio_get_level(k->pin) == 0;

        if (raw != k->last_raw) {
            k->last_raw = raw;
            k->stable_at = now + DEBOUNCE_MS * 1000;
            continue;
        }
        if (raw == k->pressed || now < k->stable_at) {
            continue;
        }

        k->pressed = raw;
        if (raw) {
            k->pressed_at = now;
            ESP_LOGD(TAG, "%s 按下", k->name);
        } else {
            const int64_t held = now - k->pressed_at;
            if (held >= INPUT_LONG_PRESS_MS * 1000) {
                ESP_LOGI(TAG, "%s 长按 %lldms", k->name, (long long)(held / 1000));
                emit(q, IN_EVT_KEY_LONG, k->id);
            } else {
                ESP_LOGI(TAG, "%s 短按", k->name);
                emit(q, IN_EVT_KEY_SHORT, k->id);
            }
        }
    }
}

static void encoder_poll(QueueHandle_t q)
{
    const int ab = (gpio_get_level(INPUT_PIN_ENC_A) << 1) | gpio_get_level(INPUT_PIN_ENC_B);
    if (ab == s_enc_last) {
        return;
    }
    const int8_t dir = ENC_DIR[(s_enc_last << 2) | ab];
    s_enc_last = ab;
    if (dir != 0) {
        ESP_LOGD(TAG, "ENC %+d", dir);
        emit(q, IN_EVT_ENC_STEP, dir);
    }
}

const char *input_type_name(input_type_t t)
{
    switch (t) {
    case IN_EVT_KEY_SHORT: return "KEY_SHORT";
    case IN_EVT_KEY_LONG:  return "KEY_LONG";
    case IN_EVT_ENC_STEP:  return "ENC_STEP";
    default:               return "?";
    }
}

static void input_task(void *arg)
{
    QueueHandle_t q = (QueueHandle_t)arg;
    keys_init();
    for (;;) {
        keys_poll(q);
        encoder_poll(q);
        vTaskDelay(pdMS_TO_TICKS(POLL_PERIOD_MS));
    }
}

void input_start(QueueHandle_t out_queue)
{
    xTaskCreate(input_task, "input", 3072, out_queue, 10, NULL);
}

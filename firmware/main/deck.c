/*
 * deck.c — AgentDock 专用 BLE GATT 通道 (NimBLE)
 *
 * 本设备不再做通用蓝牙键盘: BLE 上只有这一个自定义服务, 唯一的对端是
 * pi 扩展 (BLE central). 未连接时设备仅以 LED 显示状态, 输入无动作.
 *
 * 服务 UUID:  8e7c1a10-c0de-4b1e-9f6a-000000000001
 * EVENT char: 8e7c1a10-c0de-4b1e-9f6a-000000000002  (device→host, Notify)
 * STATE char: 8e7c1a10-c0de-4b1e-9f6a-000000000003  (host→device, Write)
 *
 * 启动顺序: deck_init() 注册服务 → nimble host sync → 开始广播.
 * 加密: 未启用 (局域信任环境, 报文仅为按键事件); bonding 配置留 M3.
 */
#include "deck.h"

#include <string.h>

#include "esp_log.h"
#include "host/ble_gap.h"
#include "host/ble_gatt.h"
#include "host/ble_hs.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include "store/config/ble_store_config.h"

#include "fx.h"

static const char *TAG = "deck";

/* ---------------- UUID ----------------
 * 8e7c1a10-c0de-4b1e-9f6a-0000000000XX (XX: 1=服务 2=EVENT 3=STATE)
 * 注意: NimBLE 的 ble_uuid128_t.value 为小端存储 (ble_uuid_to_str 从
 * value[15] 打印到 value[0]), 必须按字符串的逆序填入 */
static const ble_uuid128_t UUID_SVC   = { .u = { .type = BLE_UUID_TYPE_128 },
    .value = { 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x6a, 0x9f,
               0x1e, 0x4b, 0xde, 0xc0, 0x10, 0x1a, 0x7c, 0x8e } };
static const ble_uuid128_t UUID_EVENT = { .u = { .type = BLE_UUID_TYPE_128 },
    .value = { 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x6a, 0x9f,
               0x1e, 0x4b, 0xde, 0xc0, 0x10, 0x1a, 0x7c, 0x8e } };
static const ble_uuid128_t UUID_STATE = { .u = { .type = BLE_UUID_TYPE_128 },
    .value = { 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x6a, 0x9f,
               0x1e, 0x4b, 0xde, 0xc0, 0x10, 0x1a, 0x7c, 0x8e } };

/* ---------------- 状态 ---------------- */
typedef struct {
    uint16_t event_attr;          /* EVENT characteristic 的 val handle */
    uint16_t conn;                /* 当前连接句柄 (无效 = 0xFFFF) */
    volatile bool subscribed;     /* 主机已开启 EVENT notify */
    deck_channel_cb_t cb;
    uint8_t own_addr_type;
    char device_name[32];
} deck_ctx_t;

static deck_ctx_t s_deck = { .conn = 0xFFFF };
static struct ble_gap_event_listener s_deck_listener;

static const char *STATE_NAMES[] = { "idle", "busy", "done", "error" };

/* ---------------- STATE char 写入处理 ---------------- */
static int on_state_write(uint16_t conn, uint16_t attr,
                          struct ble_gatt_access_ctxt *ctx, void *arg)
{
    char buf[96];
    const int len = ctx->om->om_len;
    if (len <= 0 || len >= (int)sizeof(buf)) return BLE_ATT_ERR_INSUFFICIENT_RES;
    memcpy(buf, ctx->om->om_data, len);
    buf[len] = 0;

    const char *st = strstr(buf, "\"st\":\"");
    if (!st) {
        ESP_LOGW(TAG, "STATE 报文无 st 字段: %s", buf);
        return BLE_ATT_ERR_UNLIKELY;
    }
    st += 6;
    for (int i = 0; i < (int)(sizeof(STATE_NAMES) / sizeof(STATE_NAMES[0])); i++) {
        if (strncmp(st, STATE_NAMES[i], strlen(STATE_NAMES[i])) == 0) {
            ESP_LOGI(TAG, "agent 状态 → %s", STATE_NAMES[i]);
            fx_set_agent_state((deck_state_t)i);
            return 0;
        }
    }
    ESP_LOGW(TAG, "未知状态: %s", st);
    return BLE_ATT_ERR_UNLIKELY;
}

static int deck_char_access(uint16_t conn, uint16_t attr,
                            struct ble_gatt_access_ctxt *ctx, void *arg)
{
    return BLE_ATT_ERR_READ_NOT_PERMITTED;
}

/* ---------------- GATT 服务定义 ---------------- */
static const struct ble_gatt_chr_def s_chrs[] = {
    {
        .uuid = &UUID_EVENT.u,          /* device→host 事件通知 */
        .access_cb = deck_char_access,
        .flags = BLE_GATT_CHR_F_NOTIFY,
        .val_handle = &s_deck.event_attr,
    },
    {
        .uuid = &UUID_STATE.u,          /* host→device 状态写入 */
        .access_cb = on_state_write,
        .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP,
    },
    { 0 },
};

static const struct ble_gatt_svc_def s_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &UUID_SVC.u,
        .characteristics = s_chrs,
    },
    { 0 },
};

/* ---------------- GAP 事件 ---------------- */
static void start_advertising(void)
{
    /* 31 字节广播包放不下 UUID128+完整名: 广播包 = flags+UUID, 名字进 scan response */
    struct ble_hs_adv_fields fields;
    memset(&fields, 0, sizeof(fields));
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.uuids128 = (ble_uuid128_t *)&UUID_SVC;
    fields.num_uuids128 = 1;
    fields.uuids128_is_complete = 1;
    int rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv_set_fields 失败 rc=%d", rc);
        return;
    }

    struct ble_hs_adv_fields rsp;
    memset(&rsp, 0, sizeof(rsp));
    rsp.name = (uint8_t *)s_deck.device_name;
    rsp.name_len = strlen(s_deck.device_name);
    rsp.name_is_complete = 1;
    rc = ble_gap_adv_rsp_set_fields(&rsp);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv_rsp_set_fields 失败 rc=%d", rc);
        return;
    }

    struct ble_gap_adv_params params = { 0 };
    params.conn_mode = BLE_GAP_CONN_MODE_UND;
    params.disc_mode = BLE_GAP_DISC_MODE_GEN;
    /* 100~150ms: 广播电流尖峰会干扰 WS2812 供电, 间隔过密导致 LED 乱闪 */
    params.itvl_min = 160;    /* *0.625ms = 100ms */
    params.itvl_max = 240;    /* 150ms */
    rc = ble_gap_adv_start(s_deck.own_addr_type, NULL, BLE_HS_FOREVER, &params,
                           NULL, NULL);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv_start 失败 rc=%d", rc);
        return;
    }
    ESP_LOGI(TAG, "广播中: %s", s_deck.device_name);
}

static int deck_gap_event(struct ble_gap_event *event, void *arg)
{
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            s_deck.conn = event->connect.conn_handle;
            ESP_LOGI(TAG, "central 连入 (conn=%u)", s_deck.conn);
        } else {
            ESP_LOGW(TAG, "连接失败 status=%d, 重新广播", event->connect.status);
            start_advertising();
        }
        break;
    case BLE_GAP_EVENT_DISCONNECT: {
        const bool was = s_deck.subscribed;
        s_deck.subscribed = false;
        s_deck.conn = 0xFFFF;
        ESP_LOGI(TAG, "断开 (reason=%d)%s", event->disconnect.reason,
                 was ? ", 输入通道关闭" : "");
        if (was && s_deck.cb) s_deck.cb(false);
        start_advertising();
        break;
    }
    case BLE_GAP_EVENT_SUBSCRIBE:
        if (event->subscribe.attr_handle == s_deck.event_attr) {
            const bool now = event->subscribe.cur_notify != 0;
            if (now != s_deck.subscribed) {
                s_deck.subscribed = now;
                ESP_LOGI(TAG, "GATT 通道 %s (conn=%u)",
                         now ? "激活 — 输入上报开启" : "关闭 — 设备待命",
                         event->subscribe.conn_handle);
                if (s_deck.cb) s_deck.cb(now);
            }
        }
        break;
    default:
        break;
    }
    return 0;
}

/* ---------------- NimBLE host 生命周期 ---------------- */
static void on_sync(void)
{
    int rc = ble_hs_id_infer_auto(0, &s_deck.own_addr_type);
    if (rc != 0) {
        ESP_LOGE(TAG, "地址类型推断失败 rc=%d", rc);
        return;
    }
    start_advertising();
}

static void on_reset(int reason)
{
    ESP_LOGE(TAG, "host reset, reason=%d", reason);
}

/* 无公开头文件声明, 与 IDF 例程一致手工 extern */
extern void ble_store_config_init(void);

static void ble_host_task(void *param)
{
    ESP_LOGI(TAG, "NimBLE host 任务启动");
    nimble_port_run();               /* 阻塞直到 nimble_port_stop() */
    nimble_port_freertos_deinit();
}

/* ---------------- 公共 API ---------------- */
bool deck_channel_active(void)
{
    return s_deck.subscribed;
}

bool deck_send_event(const char *json)
{
    if (!s_deck.subscribed || s_deck.conn == 0xFFFF) {
        ESP_LOGD(TAG, "无订阅主机, 事件不发送: %s", json);
        return false;
    }
    struct os_mbuf *om = ble_hs_mbuf_from_flat(json, strlen(json));
    if (!om) {
        ESP_LOGW(TAG, "mbuf 分配失败, 事件丢弃: %s", json);
        return true;
    }
    const int rc = ble_gatts_notify_custom(s_deck.conn, s_deck.event_attr, om);
    if (rc != 0) {
        ESP_LOGW(TAG, "notify 失败 rc=%d: %s", rc, json);
    }
    return true;
}

void deck_set_channel_cb(deck_channel_cb_t cb)
{
    s_deck.cb = cb;
}

void deck_init(const char *device_name)
{
    snprintf(s_deck.device_name, sizeof(s_deck.device_name), "%s", device_name);

    esp_err_t ret = nimble_port_init();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "nimble_port_init 失败: %d", ret);
        return;
    }

    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.reset_cb = on_reset;
    /* Just-Works bonding: macOS/Windows 配对一次, 密钥存 NVS */
    ble_hs_cfg.sm_bonding = 1;
    ble_hs_cfg.sm_sc = 1;
    ble_hs_cfg.sm_mitm = 0;
    ble_hs_cfg.sm_io_cap = BLE_HS_IO_NO_INPUT_OUTPUT;

    ble_gatts_count_cfg(s_svcs);
    ble_gatts_add_svcs(s_svcs);
    ble_svc_gap_device_name_set(s_deck.device_name);
    ble_gap_event_listener_register(&s_deck_listener, deck_gap_event, NULL);

    ble_store_config_init();   /* 配对密钥持久化到 NVS */
    nimble_port_freertos_init(ble_host_task);
    ESP_LOGI(TAG, "deck 通道初始化完成 (%s)", s_deck.device_name);
}

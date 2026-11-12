/*
 * config.c — NVS 持久化实现
 *
 * 全部字段都是 u8, 读时缺键即默认值; 写时整份落盘 (字段少, 一次 commit 更省事).
 */
#include "config.h"

#include "esp_log.h"
#include "nvs.h"

static const char *TAG = "config";
#define NVS_NS       "agentdock"
#define KEY_MUTED    "muted"
#define KEY_CLICK    "click"
#define KEY_BRIGHT   "bright"
#define KEY_VOLUME   "volume"

static deck_config_t s_cfg = {
    .muted = false,
    .click_sound = true,
    .brightness = CONFIG_BRIGHTNESS_DEFAULT,
    .volume = CONFIG_VOLUME_DEFAULT,
};

const deck_config_t *config_get(void)
{
    return &s_cfg;
}

static uint8_t read_u8(nvs_handle_t h, const char *key, uint8_t def)
{
    uint8_t v = 0;
    if (nvs_get_u8(h, key, &v) != ESP_OK) return def;
    return v > 100 ? 100 : v;   /* 老固件/手改 NVS 的越界值兜底 */
}

void config_init(void)
{
    nvs_handle_t h;
    const esp_err_t err = nvs_open(NVS_NS, NVS_READONLY, &h);
    if (err != ESP_OK) {
        if (err != ESP_ERR_NVS_NOT_FOUND) {
            ESP_LOGW(TAG, "NVS open 失败: %s", esp_err_to_name(err));
        }
        ESP_LOGI(TAG, "配置: 使用默认值 (静音=关 刻度音=开 亮度=%d%% 音量=%d%%)",
                 CONFIG_BRIGHTNESS_DEFAULT, CONFIG_VOLUME_DEFAULT);
        return;   /* 首次启动无记录, s_cfg 已是默认值 */
    }
    uint8_t muted = 0, click = 1;
    if (nvs_get_u8(h, KEY_MUTED, &muted) != ESP_OK) muted = 0;
    if (nvs_get_u8(h, KEY_CLICK, &click) != ESP_OK) click = 1;
    s_cfg.muted = muted != 0;
    s_cfg.click_sound = click != 0;
    s_cfg.brightness = read_u8(h, KEY_BRIGHT, CONFIG_BRIGHTNESS_DEFAULT);
    s_cfg.volume = read_u8(h, KEY_VOLUME, CONFIG_VOLUME_DEFAULT);
    nvs_close(h);

    ESP_LOGI(TAG, "配置: 静音=%s 刻度音=%s 亮度=%u%% 音量=%u%%",
             s_cfg.muted ? "开" : "关", s_cfg.click_sound ? "开" : "关",
             s_cfg.brightness, s_cfg.volume);
}

static esp_err_t persist(void)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_set_u8(h, KEY_MUTED, s_cfg.muted ? 1 : 0);
    if (err == ESP_OK) err = nvs_set_u8(h, KEY_CLICK, s_cfg.click_sound ? 1 : 0);
    if (err == ESP_OK) err = nvs_set_u8(h, KEY_BRIGHT, s_cfg.brightness);
    if (err == ESP_OK) err = nvs_set_u8(h, KEY_VOLUME, s_cfg.volume);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    if (err != ESP_OK) ESP_LOGW(TAG, "配置保存失败: %s", esp_err_to_name(err));
    return err;
}

esp_err_t config_set_muted(bool muted)
{
    s_cfg.muted = muted;
    return persist();
}

esp_err_t config_set_click_sound(bool on)
{
    s_cfg.click_sound = on;
    return persist();
}

esp_err_t config_set_brightness(uint8_t pct)
{
    s_cfg.brightness = pct > 100 ? 100 : pct;
    return persist();
}

esp_err_t config_set_volume(uint8_t pct)
{
    s_cfg.volume = pct > 100 ? 100 : pct;
    return persist();
}

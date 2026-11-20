/*
 * config.c — NVS 持久化实现
 *
 * 全部字段都是 u8, 读时缺键即默认值; 写时整份落盘 (字段少, 一次 commit 更省事).
 * 老固件只有 click / volume 两个键: 升级后 click 丢弃, volume 作为三类音量的
 * 初始值 (新键存在时新键优先).
 */
#include "config.h"

#include "esp_log.h"
#include "nvs.h"

static const char *TAG = "config";
#define NVS_NS       "agentdock"
#define KEY_MUTED    "muted"
#define KEY_BRIGHT   "bright"
#define KEY_VOLUME   "volume"    /* 旧版: 单一路音量 */
#define KEY_CLICK    "click"     /* 旧版: 刻度音开关, 仅日志提示 */

static const char *VOLUME_KEYS[SOUND_CAT_COUNT] = { "vol_key", "vol_knob", "vol_agnt" };
static const char *VOLUME_NAMES[SOUND_CAT_COUNT] = { "按键", "旋钮", "agent" };

static deck_config_t s_cfg = {
    .muted = false,
    .volume = { CONFIG_KEY_VOLUME_DEFAULT, CONFIG_KNOB_VOLUME_DEFAULT,
                CONFIG_AGENT_VOLUME_DEFAULT },
    .brightness = CONFIG_BRIGHTNESS_DEFAULT,
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
        ESP_LOGI(TAG, "配置: 使用默认值 (静音=关 音量 %d/%d/%d 亮度=%d%%)",
                 CONFIG_KEY_VOLUME_DEFAULT, CONFIG_KNOB_VOLUME_DEFAULT,
                 CONFIG_AGENT_VOLUME_DEFAULT, CONFIG_BRIGHTNESS_DEFAULT);
        return;   /* 首次启动无记录, s_cfg 已是默认值 */
    }

    uint8_t muted = 0;
    if (nvs_get_u8(h, KEY_MUTED, &muted) == ESP_OK) s_cfg.muted = muted != 0;

    /* 旧版单音量 → 三类共同初值 (新键优先) */
    uint8_t legacy = 0;
    const bool has_legacy = nvs_get_u8(h, KEY_VOLUME, &legacy) == ESP_OK;
    for (int i = 0; i < SOUND_CAT_COUNT; i++) {
        uint8_t v = 0;
        if (nvs_get_u8(h, VOLUME_KEYS[i], &v) == ESP_OK) {
            s_cfg.volume[i] = v > 100 ? 100 : v;
        } else if (has_legacy) {
            s_cfg.volume[i] = legacy > 100 ? 100 : legacy;
            ESP_LOGI(TAG, "迁移旧音量 %u%% → %s", s_cfg.volume[i], VOLUME_NAMES[i]);
        }
    }
    s_cfg.brightness = read_u8(h, KEY_BRIGHT, CONFIG_BRIGHTNESS_DEFAULT);
    nvs_close(h);

    ESP_LOGI(TAG, "配置: 静音=%s 音量 按键=%u%% 旋钮=%u%% agent=%u%% 亮度=%u%%",
             s_cfg.muted ? "开" : "关", s_cfg.volume[SOUND_KEY],
             s_cfg.volume[SOUND_KNOB], s_cfg.volume[SOUND_AGENT], s_cfg.brightness);
}

static esp_err_t persist(void)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_set_u8(h, KEY_MUTED, s_cfg.muted ? 1 : 0);
    for (int i = 0; i < SOUND_CAT_COUNT && err == ESP_OK; i++) {
        err = nvs_set_u8(h, VOLUME_KEYS[i], s_cfg.volume[i]);
    }
    if (err == ESP_OK) err = nvs_set_u8(h, KEY_BRIGHT, s_cfg.brightness);
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

esp_err_t config_set_sound_volume(sound_cat_t cat, uint8_t pct)
{
    if (cat >= SOUND_CAT_COUNT) return ESP_ERR_INVALID_ARG;
    s_cfg.volume[cat] = pct > 100 ? 100 : pct;
    return persist();
}

esp_err_t config_set_brightness(uint8_t pct)
{
    s_cfg.brightness = pct > 100 ? 100 : pct;
    return persist();
}

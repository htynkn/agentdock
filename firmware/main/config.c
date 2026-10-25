/*
 * config.c — NVS 持久化实现
 */
#include "config.h"

#include "nvs.h"
#include "esp_log.h"

static const char *TAG = "config";
static const char *NVS_NAMESPACE[] = { "agentdock" };
static const char *KEY_MUTED = "muted";

esp_err_t config_load_muted(bool *out_muted)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NAMESPACE[0], NVS_READONLY, &h);
    if (err != ESP_OK) {
        if (err != ESP_ERR_NVS_NOT_FOUND) {
            ESP_LOGW(TAG, "NVS open 失败: %s", esp_err_to_name(err));
        }
        *out_muted = false;
        return ESP_OK;   /* 首次启动无记录, 默认不静音 */
    }
    uint8_t v = 0;
    err = nvs_get_u8(h, KEY_MUTED, &v);
    nvs_close(h);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        *out_muted = false;
        return ESP_OK;
    }
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "NVS get 失败: %s", esp_err_to_name(err));
        *out_muted = false;
        return err;
    }
    *out_muted = v != 0;
    return ESP_OK;
}

esp_err_t config_save_muted(bool muted)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NAMESPACE[0], NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_set_u8(h, KEY_MUTED, muted ? 1 : 0);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "静音状态保存失败: %s", esp_err_to_name(err));
    }
    return err;
}

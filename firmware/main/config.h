/*
 * config.h — NVS 持久化配置
 *
 * 单例配置: 开机 config_init() 从 NVS 读一次到 RAM, 之后读 config_get(),
 * 改 config_set_*() (改 RAM 后立即落盘). fx 层只在用时读取, 不缓存副本,
 * 所以改配置 = 立即生效, 无需通知链.
 *
 * 键: muted / click / bright / volume (命名空间 agentdock)
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#define CONFIG_BRIGHTNESS_DEFAULT 100
#define CONFIG_VOLUME_DEFAULT     100

typedef struct {
    bool muted;          /* 蜂鸣器总静音 (KEY1 长按) */
    bool click_sound;    /* 旋钮刻度音 (KEY3 长按) */
    uint8_t brightness;  /* LED 亮度 0~100 (%) */
    uint8_t volume;      /* 蜂鸣器音量 0~100 (%) */
} deck_config_t;

/* 从 NVS 载入 (字段缺失/首次启动用默认值); 失败不致命, 只降级为默认值 */
void config_init(void);

/* 当前配置 (只读, 生命周期 = 进程); config_init 之前返回默认值 */
const deck_config_t *config_get(void);

/* 改单个字段并立即落盘 (值越界自动钳制) */
esp_err_t config_set_muted(bool muted);
esp_err_t config_set_click_sound(bool on);
esp_err_t config_set_brightness(uint8_t pct);
esp_err_t config_set_volume(uint8_t pct);

/*
 * config.h — NVS 持久化配置
 *
 * 单例配置: 开机 config_init() 从 NVS 读一次到 RAM, 之后读 config_get(),
 * 改 config_set_*() (改 RAM 后立即落盘). fx 层只在用时读取, 不缓存副本,
 * 所以改配置 = 立即生效, 无需通知链.
 *
 * 声音分三类, 各自独立音量 (0~100, 0 = 该类别关闭); 另有总静音 (KEY1 长按),
 * 总静音优先于三类音量. 旋钮刻度音最频繁, 默认音量比其它两类低.
 *
 * 键: muted / vol_key / vol_knob / vol_agnt / bright (命名空间 agentdock)
 * 旧版键 click / volume 仍会被读取一次 (迁移), 新固件写回后不再使用.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

/* 声音类别 — 与 fx 旋律表、/dock 面板顺序一致 */
typedef enum {
    SOUND_KEY = 0,     /* 按键音: KEY1/2/3 与旋钮按压 */
    SOUND_KNOB,        /* 旋钮旋转刻度音 */
    SOUND_AGENT,       /* agent 提示音: 启动/完成/出错/待处理 */
    SOUND_CAT_COUNT,
} sound_cat_t;

#define CONFIG_KEY_VOLUME_DEFAULT    100
#define CONFIG_KNOB_VOLUME_DEFAULT   60    /* 刻度音最频繁, 默认压低 */
#define CONFIG_AGENT_VOLUME_DEFAULT  100
#define CONFIG_BRIGHTNESS_DEFAULT    100

typedef struct {
    bool muted;                          /* 总静音: 所有声音 (KEY1 长按) */
    uint8_t volume[SOUND_CAT_COUNT];     /* 三类音量 0~100 (0 = 关) */
    uint8_t brightness;                  /* LED 亮度 0~100 (%) */
} deck_config_t;

/* 从 NVS 载入 (字段缺失/首次启动用默认值); 失败不致命, 只降级为默认值 */
void config_init(void);

/* 当前配置 (只读, 生命周期 = 进程); config_init 之前返回默认值 */
const deck_config_t *config_get(void);

/* 改单个字段并立即落盘 (值越界自动钳制) */
esp_err_t config_set_muted(bool muted);
esp_err_t config_set_sound_volume(sound_cat_t cat, uint8_t pct);
esp_err_t config_set_brightness(uint8_t pct);

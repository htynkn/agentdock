/*
 * fx.h — 声音语言 (RTTTL 旋律) 与 LED 效果引擎
 *
 * 两个后台任务, 职责分离, 所有 API 非阻塞:
 *   fx  任务 — 蜂鸣器: 事件音效 / 刻度音 / 演示旋律 (RTTTL 解析在这)
 *   led 任务 — WS2812 状态机, 100ms tick. 旋律播放时灯光不卡顿 (演示模式需要
 *              声光同时进行, 单任务实现会把动画冻结在 melody 播放期间).
 * 旋律为 RTTTL 文本 (诺基亚铃声格式), 直接改字符串即可换音效.
 * 旋钮刻度音不走 RTTTL (11ms 的双段滑音), 参数见 fx.c 的 CLICK_CW/CLICK_CCW.
 * 音量/亮度/静音/刻度音开关均读 config (唯一真源, 改完立即生效并落盘).
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "app_events.h"

/* 事件音效 — RTTTL 定义见 fx.c 顶部 s_melodies[] */
typedef enum {
    FX_BOOT = 0,       /* 开机: Mario 升级琶音 */
    FX_CONFIRM,        /* 事件确认: Mario 金币 */
    FX_ERROR,          /* 出错: 下行叮咚 */
    FX_ATTENTION,      /* 注意/提问: 两连高音 */
    FX_MUTED_ON,       /* 静音/刻度音 开: 一短一长 */
    FX_MUTED_OFF,      /* 静音/刻度音 关: 一长一短 */
    FX_DISCONNECT,     /* 断连: 单长低音 */
    FX_DEMO,           /* 演示模式: 魂斗罗 riff (KEY2 长按) */
    FX_COUNT,
} fx_melody_t;

void fx_init(void);

/* 播放事件音效 (非阻塞, 请求入队; 队列满则丢弃并记日志) */
void fx_play(fx_melody_t id);

/* 旋钮刻度音 (非阻塞): dir > 0 顺时针 (上滑), dir < 0 逆时针 (下滑).
 * 每格会自动合并成一次发声, 静音时无声; 与事件音效共用 fx 任务, 用户
 * 旋转的优先级高于正在播放的旋律 (在旋律句读处插播). */
void fx_encoder_click(int32_t dir);

/* 静音 (同时持久化到 NVS, 立即掐断当前发声) */
void fx_set_muted(bool muted);
bool fx_is_muted(void);

/* 旋钮刻度音开关 (同时持久化; KEY3 长按切换) */
void fx_set_click_enabled(bool on);
bool fx_is_click_enabled(void);

/* 蜂鸣器音量 0~100 (同时持久化; 0 = 无声, 与静音等效) */
void fx_set_volume(uint8_t pct);
uint8_t fx_get_volume(void);

/* LED 亮度 0~100 (同时持久化; 相对百分比, 100 = 原始配色) */
void fx_set_brightness(uint8_t pct);
uint8_t fx_get_brightness(void);

/* LED 常亮色 (0~255), 后续动画需求再扩展 */
void fx_led_set(uint8_t r, uint8_t g, uint8_t b);

/* 未连接 (无 pi 扩展): LED 心跳待命 */
void fx_set_offline(void);

/* agent 状态 → LED 灯效 (由 deck GATT 通道驱动):
 *   idle 蓝微亮 / busy 绿呼吸 / done 白双闪回蓝 / error 红三闪回蓝
 *   demo 七彩呼吸 ~3s 后回到上一个 agent 状态 (灯效测试的「自动」) */
void fx_set_agent_state(deck_state_t state);

/* 演示模式 (KEY2 长按): 魂斗罗旋律 + 七彩呼吸 ~3s, 不依赖 BLE 连接 */
void fx_demo_start(void);

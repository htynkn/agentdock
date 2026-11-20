/*
 * fx.h — 声音语言 (RTTTL 旋律) 与 LED 效果引擎
 *
 * 两个后台任务, 职责分离, 所有 API 非阻塞:
 *   fx  任务 — 蜂鸣器: 事件音效 / 刻度音 / 演示旋律 (RTTTL 解析在这)
 *   led 任务 — WS2812 状态机, 100ms tick. 旋律播放时灯光不卡顿 (演示模式需要
 *              声光同时进行, 单任务实现会把动画冻结在 melody 播放期间).
 * 旋律为 RTTTL 文本 (诺基亚铃声格式), 直接改字符串即可换音效.
 * 旋钮刻度音不走 RTTTL (11ms 的双段滑音), 参数见 fx.c 的 CLICK_CW/CLICK_CCW.
 *
 * 声音分三类 (sound_cat_t, 见 config.h), 各有独立音量 0~100 (0 = 关):
 *   SOUND_KEY   按键音 — KEY1/2/3、旋钮按压、静音开关反馈
 *   SOUND_KNOB  刻度音 — 旋钮旋转
 *   SOUND_AGENT agent 提示音 — 启动/完成/出错/待处理/断连
 * 另有三类之上的总静音 (KEY1 长按), 音量/静音均读 config (唯一真源).
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "app_events.h"
#include "config.h"

/* 事件音效 — RTTTL 定义见 fx.c 顶部 s_melodies[] */
typedef enum {
    FX_BOOT = 0,       /* 开机: Mario 升级琶音 (agent) */
    FX_CONFIRM,        /* 按键确认: Mario 金币 (key) */
    FX_DONE,           /* agent 完成: 三音上行收束 (agent) */
    FX_ERROR,          /* 出错: 下行叮咚 (agent) */
    FX_ATTENTION,      /* 需要人处理: 三连提示 (agent) */
    FX_MUTED_ON,       /* 总静音 开: 一短一长 (key, 总静音下仍响) */
    FX_MUTED_OFF,      /* 总静音 关: 一长一短 (key, 总静音下仍响) */
    FX_DISCONNECT,     /* 断连: 单长低音 (agent) */
    FX_DEMO,           /* 演示模式: 号角 fanfare (KEY2 长按) (key) */
    FX_PREVIEW,        /* 保留: 试听占位 (刻度音试听走 fx_preview 专用路径) */
    FX_COUNT,
} fx_melody_t;

void fx_init(void);

/* 播放事件音效 (非阻塞, 请求入队; 队列满则丢弃并记日志) */
void fx_play(fx_melody_t id);

/* 试听某一类声音 (面板调音量时用): 用该类当前音量播它的代表音.
 * 音量为 0 或总静音时无声 —— 这正是要让人听到的效果. */
void fx_preview(sound_cat_t cat);

/* 旋钮刻度音 (非阻塞): dir > 0 顺时针 (上滑), dir < 0 逆时针 (下滑).
 * 每格会自动合并成一次发声, 音量 0 或总静音时无声; 与事件音效共用 fx 任务,
 * 用户旋转的优先级高于正在播放的旋律 (在旋律句读处插播). */
void fx_encoder_click(int32_t dir);

/* 总静音 (同时持久化到 NVS, 立即掐断当前发声) */
void fx_set_muted(bool muted);
bool fx_is_muted(void);

/* 某一类声音的音量 0~100 (同时持久化; 0 = 该类静音) */
void fx_set_sound_volume(sound_cat_t cat, uint8_t pct);
uint8_t fx_get_sound_volume(sound_cat_t cat);

/* LED 亮度 0~100 (同时持久化; 相对百分比, 100 = 原始配色) */
void fx_set_brightness(uint8_t pct);
uint8_t fx_get_brightness(void);

/* LED 常亮色 (0~255), 后续动画需求再扩展 */
void fx_led_set(uint8_t r, uint8_t g, uint8_t b);

/* 未连接 (无 pi 扩展): LED 心跳待命 */
void fx_set_offline(void);

/* agent 状态 → 灯效 (由 deck GATT 通道驱动):
 *   idle      蓝微亮 (持久)
 *   busy      绿呼吸 (持久)
 *   attention 琥珀双脉冲 (持久, 等人操作)
 *   done      白双闪后回到 then
 *   error     红三闪后回到 then
 *   demo      七彩呼吸 ~3s 后回到 then
 * then = DECK_STATE_KEEP 时回到当前持久状态. 声音由调用方决定 (deck.c). */
void fx_set_agent_state(deck_state_t state, deck_state_t then);

/* 演示模式 (KEY2 长按): 号角 fanfare + 七彩呼吸 ~3s, 不依赖 BLE 连接 */
void fx_demo_start(void);

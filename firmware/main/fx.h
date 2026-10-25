/*
 * fx.h — 声音语言 (RTTTL 旋律) 与 LED 效果引擎
 *
 * 单一后台任务消费请求, 所有 API 非阻塞; 静音开关最高优先级 (duty=0 物理静音).
 * 旋律为 RTTTL 文本 (诺基亚铃声格式), 直接改字符串即可换音效.
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
    FX_MUTED_ON,       /* 静音开: 一短一长 */
    FX_MUTED_OFF,      /* 静音关: 一长一短 */
    FX_DISCONNECT,     /* 断连: 单长低音 */
    FX_COUNT,
} fx_melody_t;

void fx_init(void);

/* 播放事件音效 (非阻塞, 请求入队; 队列满则丢弃并记日志) */
void fx_play(fx_melody_t id);

/* 静音 (立即停止当前播放并静音后续请求中的发声部分) */
void fx_set_muted(bool muted);
bool fx_is_muted(void);

/* LED 常亮色 (0~255), 后续动画需求再扩展 */
void fx_led_set(uint8_t r, uint8_t g, uint8_t b);

/* 未连接 (无 pi 扩展): LED 心跳待命 */
void fx_set_offline(void);

/* agent 状态 → LED 灯效 (由 deck GATT 通道驱动):
 *   idle 蓝微亮 / busy 绿呼吸 / done 白双闪回蓝 / error 红三闪回蓝 */
void fx_set_agent_state(deck_state_t state);

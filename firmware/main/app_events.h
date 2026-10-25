/*
 * app_events.h — AgentDock 内部事件定义
 *
 * input 任务产生输入事件 → app 任务消费并分发 (HID 发送 / 音效 / 配置).
 * 单一事件队列贯穿全系统, 便于日志追踪与后续扩展 (M2 增加 GATT 事件源).
 */
#pragma once

#include <stdint.h>

/* 输入事件类型 */
typedef enum {
    IN_EVT_NONE = 0,
    IN_EVT_KEY_SHORT,      /* value: key_id */
    IN_EVT_KEY_LONG,       /* value: key_id */
    IN_EVT_ENC_STEP,       /* value: +1 顺时针 / -1 逆时针 */
} input_type_t;

/* 物理按键 ID (与原理图 U2 引脚对应, 见 README) */
typedef enum {
    KEY_ID_1 = 1,          /* IO4  — Esc / 静音(长按) */
    KEY_ID_2 = 2,          /* IO5  — 宏 "continue" */
    KEY_ID_3 = 3,          /* IO6  — Enter */
    KEY_ID_ENC_SW = 4,     /* IO10 — 旋钮按压 = Enter */
} key_id_t;

typedef struct {
    input_type_t type;
    int32_t value;
} input_event_t;

/* 事件 → 可读名, 仅供日志 */
const char *input_type_name(input_type_t t);

/* agent 状态 (pi 扩展 → 设备, 驱动 LED) */
typedef enum {
    DECK_STATE_IDLE = 0,   /* 蓝色微亮 */
    DECK_STATE_BUSY,       /* 绿色呼吸 */
    DECK_STATE_DONE,       /* 白色双闪 → 蓝 */
    DECK_STATE_ERROR,      /* 红色三连闪 → 蓝 */
} deck_state_t;

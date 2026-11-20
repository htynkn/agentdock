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
    KEY_ID_1 = 1,          /* IO4  — 打断 agent / 长按 = 总静音开关 */
    KEY_ID_2 = 2,          /* IO5  — 宏「继续」/ 长按 = 演示模式 */
    KEY_ID_3 = 3,          /* IO6  — 宏「不对」 */
    KEY_ID_ENC_SW = 4,     /* IO10 — 旋钮按压 = 继续 */
} key_id_t;

typedef struct {
    input_type_t type;
    int32_t value;
} input_event_t;

/* 事件 → 可读名, 仅供日志 */
const char *input_type_name(input_type_t t);

/* agent 状态 (pi 扩展 → 设备, 驱动 LED + 提示音) */
typedef enum {
    DECK_STATE_IDLE = 0,   /* 蓝色微亮 */
    DECK_STATE_BUSY,       /* 绿色呼吸 */
    DECK_STATE_DONE,       /* 白色双闪 + 完成音 → 回 then */
    DECK_STATE_ERROR,      /* 红色三连闪 + 出错音 → 回 then */
    DECK_STATE_ATTENTION,  /* 琥珀色双脉冲 + 待处理提示音 (等人操作) */
    DECK_STATE_DEMO,       /* 七彩呼吸 ~3s 后回 then (灯效测试「自动」) */
    DECK_STATE_KEEP = 0xFF,/* 传参用: 瞬态结束后保持原状态 (不是真实灯效) */
} deck_state_t;

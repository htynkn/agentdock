/*
 * deck.h — AgentDock 自定义 GATT 通道
 *
 * 与 HID 并存的第二个 GATT 服务, 供 pi 扩展 (BLE central) 使用:
 *   - DECK_EVENT (device→host, Notify): 按键/旋钮事件 JSON
 *   - DECK_STATE (host→device, Write):  agent 状态 JSON (驱动 LED)
 *
 * 路由原则 (见 agent-deck-design.md §2.1):
 *   GATT 通道已连接 → 事件走通道, 动作由扩展经 pi API 执行 (不依赖窗口焦点)
 *   未连接          → 降级为 HID 盲打
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "app_events.h"   /* deck_state_t */

typedef void (*deck_channel_cb_t)(bool active);

/* 初始化 GATT 服务 (必须在 hid_init 之前调用 — 服务需在 host sync 前注册) */
void deck_init(const char *device_name);

/* 通道是否有主机订阅 (pi 扩展已连接并开启通知) */
bool deck_channel_active(void);

/* 发送事件 JSON (通道未激活时返回 false, 上层应走 HID) */
bool deck_send_event(const char *json);

/* GATT 通道激活/断开回调 (用于 LED 提示) */
void deck_set_channel_cb(deck_channel_cb_t cb);

/*
 * deck.h — AgentDock 自定义 GATT 通道
 *
 * BLE 上只暴露这一个服务, 唯一对端是 pi 扩展 (BLE central):
 *   - DECK_EVENT (device→host, Notify): 按键/旋钮事件 + 设置快照
 *   - DECK_STATE (host→device, Write):  agent 状态 / 设置 / 试听
 *
 * 未连接时输入无动作 (没有 HID 降级), LED 心跳显示待命.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "app_events.h"   /* deck_state_t */

typedef void (*deck_channel_cb_t)(bool active);

/* 初始化 GATT 服务 (必须在 nimble host sync 前调用 — 服务需先注册) */
void deck_init(const char *device_name);

/* 通道是否有主机订阅 (pi 扩展已连接并开启通知) */
bool deck_channel_active(void);

/* 发送事件 JSON (通道未激活时返回 false, 事件丢弃) */
bool deck_send_event(const char *json);

/* GATT 通道激活/断开回调 (用于 LED 提示) */
void deck_set_channel_cb(deck_channel_cb_t cb);

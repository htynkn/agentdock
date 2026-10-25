/*
 * input.h — 按键/旋钮扫描
 *
 * 1ms 周期轮询 (task), 输出消抖后的事件:
 *   - 按键: 短按(<800ms) / 长按(>=800ms), 松开才算短按
 *   - 旋钮: 正交解码, 每 1 格一个 +/- 事件
 */
#pragma once

#include "app_events.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

/* 引脚映射 — 对应原理图 U2 (ESPC2-M1-N2) */
#define INPUT_PIN_KEY1    4
#define INPUT_PIN_KEY2    5
#define INPUT_PIN_KEY3    6
#define INPUT_PIN_ENC_A   7
#define INPUT_PIN_ENC_B   18
#define INPUT_PIN_ENC_SW  10

#define INPUT_LONG_PRESS_MS  800

/* 初始化并启动扫描任务. 事件将投递到 queue (由 app 层创建并传入). */
void input_start(QueueHandle_t out_queue);

/*
 * config.h — NVS 持久化配置
 *
 * 目前仅静音开关; 后续宏集/自定义宏/GATT 配对信息也走这里.
 */
#pragma once

#include <stdbool.h>

#include "esp_err.h"

/* 读取静音开关 (键不存在时返回 false) */
esp_err_t config_load_muted(bool *out_muted);

esp_err_t config_save_muted(bool muted);

/*
 * fx.c — 声音/LED 效果引擎
 *
 * 声音: 无源蜂鸣器 (IO1) 经 LEDC PWM 驱动, 频率=音高, 50% duty=响.
 * LED:  单颗 WS2812 (IO3), C2 无 RMT 走 led_strip SPI 后端.
 * 架构: fx 任务轮询请求队列与音符队列, 全非阻塞; 静音时发送 duty=0.
 */
#include "fx.h"

#include <math.h>
#include <string.h>

#include "driver/ledc.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "led_strip.h"
#include "led_strip_spi.h"

#include "config.h"
#include "deck.h"

static const char *TAG = "fx";

#define BUZZER_GPIO      1
#define LED_GPIO         3
#define GAP_MS           15      /* 音符间断句, 避免连音 */
#define FX_QUEUE_LEN     4

/* ---------------- 旋钮刻度音参数 (改这里换手感) ----------------
 * EC11 每格 4 个正交跳变 (见 input.c), 滚动语义按跳变计数, 但人耳要的是
 * 「一格一声」, 所以两个方向都做成两段短促滑音 (上滑/下滑), 再靠
 * CLICK_GAP_MS 把同格的连跳合并成一次发声.
 *
 *   顺时针 2200Hz → 3000Hz  (上滑, "提")
 *   逆时针 2200Hz → 1500Hz  (下滑, "沉")
 * 共同起音让人只注意尾部走向, 方向差异在快转时也能听出来. */
#define CLICK_GAP_MS     22      /* 两次刻度音最小间隔 (合并同格连跳) */
#define CLICK_QUEUE_LEN  4       /* 积压上限: 快转时宁可丢也不延迟 */
typedef struct {
    uint16_t hz;
    uint8_t ms;
} click_step_t;
static const click_step_t CLICK_CW[]  = { { 2200, 5 }, { 3000, 6 } };
static const click_step_t CLICK_CCW[] = { { 2200, 5 }, { 1500, 6 } };

/* ---------------- RTTTL 解析 ---------------- */
/* 格式: 名字:d=默认时长,o=默认八度,b=BPM:音符,音符,...
 * 音符: [时长]音名[#][.][八度]  时长 1/2/4/8/16, 附点 x1.5, p=休止 */
#define RTTTL_MAX_NOTES 32

typedef struct {
    int freq_hz;     /* 0 = 休止 */
    int ms;
} note_t;

static const int SEMITONE[7] = { 9, 11, 0, 2, 4, 5, 7 };   /* a b c d e f g */

/* 解析一段 RTTTL 音符序列到 notes[], 返回音符数, 失败返回负数 */
static int rtttl_parse(const char *rtttl, note_t *notes, int max_notes)
{
    const char *p = strchr(rtttl, ':');
    if (!p) return -1;

    int def_d = 4, def_o = 5, bpm = 63;
    char item[16];
    while (p && *++p && *p != ':') {
        if (sscanf(p, "%15[^:,]", item) == 1) {
            if (item[0] == 'd' && item[1] == '=') def_d = atoi(item + 2);
            else if (item[0] == 'o' && item[1] == '=') def_o = atoi(item + 2);
            else if (item[0] == 'b' && item[1] == '=') bpm = atoi(item + 2);
        }
        p = strpbrk(p, ",:");
        if (!p || *p == ':') break;
    }
    if (!p) return -1;
    if (bpm <= 0 || def_d <= 0) return -1;
    const float quarter_ms = 60000.0f / bpm;

    int n = 0;
    while (*++p && n < max_notes) {
        if (*p == ',' || *p == ' ') continue;

        int dur = 0, oct = 0;
        char letter = 0;
        bool sharp = false, dotted = false;

        if (*p >= '1' && *p <= '9') { dur = atoi(p); while (*p >= '0' && *p <= '9') p++; }
        letter = *p++;
        if (letter >= 'A' && letter <= 'G') letter += 32;
        if (*p == '#') { sharp = true; p++; }
        if (*p == '.') { dotted = true; p++; }
        if (*p >= '4' && *p <= '7') { oct = *p - '0'; p++; }

        if (letter < 'a' || letter > 'g') {
            ESP_LOGW(TAG, "RTTTL 非法音符 '%c', 跳过", letter);
            while (*p && *p != ',') p++;
            continue;
        }
        const int d = dur ? dur : def_d;
        const int o = oct ? oct : def_o;
        if (d <= 0 || o < 1 || o > 8) return -2;

        const float ms = quarter_ms * 4.0f / d * (dotted ? 1.5f : 1.0f);
        notes[n].ms = (int)(ms + 0.5f);
        if (letter == 'p') {
            notes[n].freq_hz = 0;
        } else {
            const int semi = SEMITONE[letter - 'a'] + (sharp ? 1 : 0) + (o - 4) * 12;
            notes[n].freq_hz = (int)(440.0f * powf(2.0f, semi / 12.0f) + 0.5f);
        }
        n++;
        if (*p != ',') break;
    }
    return n;
}

/* ---------------- 事件音效定义 (改这里换音效) ---------------- */
static const char *MELODY_XP_OFF_UP   = "xpoff:d=4,o=5,b=230:g#5,f#5,f5,2c#5";   /* 预留彩蛋 */
static const char *s_melodies[FX_COUNT] = {
    [FX_BOOT]       = "boot:d=16,o=5,b=300:c,e,g,c6,e6,g6",          /* Mario 升级琶音 */
    [FX_CONFIRM]    = "confirm:d=8,o=6,b=300:b5,4e6",                /* Mario 金币 */
    [FX_ERROR]      = "error:d=4,o=4,b=240:g4,4c#4",                 /* 下行叮咚 */
    [FX_ATTENTION]  = "ask:d=8,o=6,b=200:e6,e6",                     /* 两连高音 */
    [FX_MUTED_ON]   = "muteon:d=8,o=6,b=250:e6,4e6",                 /* 一短一长 */
    [FX_MUTED_OFF]  = "muteoff:d=8,o=6,b=250:4e6,e6",                /* 一长一短 */
    [FX_DISCONNECT] = "offline:d=4,o=4,b=200:c4",                    /* 单长低音 */
    /* 魂斗罗 (Contra) 丛林关主 riff: 16 分音符琶音, 4 小节 ≈ 1.7s */
    [FX_DEMO]       = "contra:d=16,o=4,b=190:a,a,a,a,c5,d5,e5,d5,c5,b4,c5,"
                      "a,a,a,a,g4,a4,b4,a4,g4,a4",
    /* 音量试听: 两个短音 (约 160ms), 响度差异最好辩 */
    [FX_PREVIEW]    = "preview:d=16,o=5,b=220:a5,c6",
};
_Static_assert(sizeof(s_melodies) / sizeof(s_melodies[0]) == FX_COUNT, "旋律表与枚举不齐");

/* ---------------- 状态与任务 ---------------- */
typedef struct {
    led_strip_handle_t led;
    QueueHandle_t requests;
    QueueHandle_t clicks;          /* 旋钮刻度音请求 (int8_t: +1/-1) */
    int64_t last_click_us;         /* 上次刻度音时刻, 用于合并连跳 */
    int8_t last_click_dir;         /* 上次刻度音方向, 换向时立即响应 */
} fx_ctx_t;

static fx_ctx_t s_fx;

/* 音量 → LEDC duty (10bit, 50% duty = 满音量). 静音时直接 0. */
static void buzzer_hw(bool on)
{
    uint32_t duty = 0;
    if (on && !config_get()->muted) {
        duty = 512u * config_get()->volume / 100u;
    }
    /* duty 0 = MOSFET 关断, 物理静音 */
    ESP_ERROR_CHECK(ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, duty));
    ESP_ERROR_CHECK(ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0));
}

/* 刻度音: 两段短音, 方向决定尾部走向. 静音时完全不出声. */
static void click_play(int8_t dir)
{
    if (config_get()->muted) return;
    const click_step_t *steps = dir > 0 ? CLICK_CW : CLICK_CCW;
    for (int i = 0; i < 2; i++) {
        ESP_ERROR_CHECK(ledc_set_freq(LEDC_LOW_SPEED_MODE, LEDC_TIMER_0, steps[i].hz));
        buzzer_hw(true);
        vTaskDelay(pdMS_TO_TICKS(steps[i].ms));
        buzzer_hw(false);
    }
}

/* 取一条刻度音请求播放. 返回是否播放了 (没有请求返回 false). */
static bool click_drain(void)
{
    int8_t dir;
    if (xQueueReceive(s_fx.clicks, &dir, 0) != pdTRUE) return false;
    click_play(dir);
    return true;
}

/* 丢弃积压的刻度音 (静音切换/旋律结束), 避免延迟到下次才响 */
static void click_flush(void)
{
    int8_t dir;
    while (xQueueReceive(s_fx.clicks, &dir, 0) == pdTRUE) { }
}

static void play_notes(const note_t *notes, int count)
{
    for (int i = 0; i < count; i++) {
        if (notes[i].freq_hz > 0 && !config_get()->muted) {
            ESP_ERROR_CHECK(ledc_set_freq(LEDC_LOW_SPEED_MODE, LEDC_TIMER_0, notes[i].freq_hz));
            buzzer_hw(true);
        }
        vTaskDelay(pdMS_TO_TICKS(notes[i].ms));
        buzzer_hw(false);
        vTaskDelay(pdMS_TO_TICKS(GAP_MS));
        click_drain();   /* 旋律句读处插播刻度音, 不打断节拍 */
    }
    click_flush();       /* 旋律整体结束时清掉残留, 保持刻度音实时 */
}

/* ---------------- LED 状态机 (由 led 任务独占渲染) ---------------- */
typedef enum {
    LED_MODE_OFFLINE,    /* 未连接: 每 1s 极暗蓝光心跳 */
    LED_MODE_STATIC,     /* 常亮 (idle 蓝) */
    LED_MODE_BREATHING,  /* 呼吸 (busy 绿) */
    LED_MODE_FLASH_N,    /* 闪 N 次后回 base (done/error) */
    LED_MODE_DEMO,       /* 七彩呼吸 N tick 后回 agent 状态 (演示/灯效测试) */
} led_mode_t;

#define LED_TICK_MS      100
#define LED_DEMO_TICKS   30   /* 3s: 与扩展侧 TRANSIENT_MS 对齐 */
#define LED_DEMO_HOLD    4    /* 每种颜色保持的 tick 数 (7 色 ≈ 2.8s) */
/* 呼吸曲线: 峰值 32 = 缩放基准 (100ms/tick, 2s 周期) */
static const uint8_t LED_BREATH[10] = { 4, 8, 14, 20, 24, 26, 24, 20, 14, 8 };
/* 七彩: 红 橙 黄 绿 青 蓝 紫 (值为峰值, 再乘呼吸系数) */
static const uint8_t LED_RAINBOW[7][3] = {
    { 40, 0, 0 }, { 40, 20, 0 }, { 40, 40, 0 }, { 0, 40, 0 },
    { 0, 30, 40 }, { 0, 0, 40 }, { 20, 0, 40 },
};

/* 状态由多个任务 (app 任务改状态 / led 任务渲染) 访问 → 互斥锁保护 */
static SemaphoreHandle_t s_led_mtx;
static led_mode_t s_led_mode = LED_MODE_OFFLINE;
static deck_state_t s_agent_state = DECK_STATE_IDLE;   /* demo 结束后回这里 */
static uint8_t s_led_base[3] = { 0, 0, 40 };      /* idle 蓝 (微亮) */
static uint8_t s_led_active[3] = { 0, 0, 0 };
static int s_led_flashes_left = 0;
static bool s_led_flash_on = false;   /* FLASH_N 相位: true=亮(active) false=灭(黑) */
static int s_led_demo_tick = 0;
static int s_led_phase = 0;           /* 呼吸相位: 跨模式共用, 切模式不跳变 */

/* 只改状态不渲染 (锁内调) */
static void led_apply_agent_state(deck_state_t state)
{
    switch (state) {
    case DECK_STATE_IDLE:
        s_led_mode = LED_MODE_STATIC;
        s_led_base[0] = 0; s_led_base[1] = 0; s_led_base[2] = 40;   /* 蓝 */
        break;
    case DECK_STATE_BUSY:
        s_led_mode = LED_MODE_BREATHING;
        s_led_active[0] = 0; s_led_active[1] = 40; s_led_active[2] = 0;   /* 绿 */
        break;
    case DECK_STATE_DONE:
        s_led_mode = LED_MODE_FLASH_N;
        s_led_active[0] = 40; s_led_active[1] = 40; s_led_active[2] = 40;   /* 白 */
        s_led_flashes_left = 4;   /* 双闪 = 亮灭亮灭 */
        s_led_flash_on = true;    /* 先亮相, 首拍即见效果色 */
        break;
    case DECK_STATE_ERROR:
        s_led_mode = LED_MODE_FLASH_N;
        s_led_active[0] = 40; s_led_active[1] = 0; s_led_active[2] = 0;   /* 红 */
        s_led_flashes_left = 6;   /* 三连闪 */
        s_led_flash_on = true;
        break;
    case DECK_STATE_DEMO:
        s_led_mode = LED_MODE_DEMO;
        s_led_demo_tick = 0;
        break;
    default:
        break;
    }
}

/* 渲染一帧 (锁内调) */
static void apply_led(void)
{
    uint8_t r = 0, g = 0, b = 0;
    switch (s_led_mode) {
    case LED_MODE_BREATHING: {
        const uint8_t k = LED_BREATH[s_led_phase];
        s_led_phase = (s_led_phase + 1) % 10;
        r = s_led_active[0] * k / 32;
        g = s_led_active[1] * k / 32;
        b = s_led_active[2] * k / 32;
        break;
    }
    case LED_MODE_DEMO: {
        const uint8_t k = LED_BREATH[s_led_phase];
        s_led_phase = (s_led_phase + 1) % 10;
        const uint8_t *c = LED_RAINBOW[(s_led_demo_tick / LED_DEMO_HOLD) % 7];
        r = c[0] * k / 32;
        g = c[1] * k / 32;
        b = c[2] * k / 32;
        if (++s_led_demo_tick >= LED_DEMO_TICKS) {
            led_apply_agent_state(s_agent_state);   /* 跳完一圈回真实状态 */
        }
        break;
    }
    case LED_MODE_FLASH_N: {
        /* 闪 = active↔黑 交替, 闪完回 base 常亮. 灭相必须是黑:
         * 若灭相显示 base, error/done 会变成「红蓝/白蓝交替」而非纯色闪烁 */
        if (s_led_flash_on) { s_led_flash_on = false; }
        else { s_led_flash_on = true; s_led_flashes_left--; }
        r = s_led_flash_on ? s_led_active[0] : 0;
        g = s_led_flash_on ? s_led_active[1] : 0;
        b = s_led_flash_on ? s_led_active[2] : 0;
        if (s_led_flashes_left <= 0) s_led_mode = LED_MODE_STATIC;
        break;
    }
    case LED_MODE_OFFLINE: {
        static int hb = 0;
        const uint8_t v = (hb < 2) ? 6 : 0;   /* 1s 周期, 前 200ms 微亮 */
        hb = (hb + 1) % 10;
        r = 0; g = 0; b = v;
        break;
    }
    case LED_MODE_STATIC:
    default:
        r = s_led_base[0]; g = s_led_base[1]; b = s_led_base[2];
        break;
    }

    /* 亮度 = 相对百分比缩放 (100 = 原始配色; 0 = 全灭) */
    const uint8_t bright = config_get()->brightness;
    if (bright < 100) {
        r = (uint8_t)(r * bright / 100);
        g = (uint8_t)(g * bright / 100);
        b = (uint8_t)(b * bright / 100);
    }

    static uint8_t last[3] = { 0xFF, 0xFF, 0xFF };
    if (last[0] == r && last[1] == g && last[2] == b) return;   /* 无变化不刷 SPI */
    last[0] = r; last[1] = g; last[2] = b;
    ESP_ERROR_CHECK(led_strip_set_pixel(s_fx.led, 0, r, g, b));
    ESP_ERROR_CHECK(led_strip_refresh(s_fx.led));
}

/* 独立 LED 任务: 旋律播放期间动画照常跑 (演示模式声光同时) */
static void led_task(void *arg)
{
    for (;;) {
        xSemaphoreTake(s_led_mtx, portMAX_DELAY);
        apply_led();
        xSemaphoreGive(s_led_mtx);
        vTaskDelay(pdMS_TO_TICKS(LED_TICK_MS));
    }
}

void fx_set_offline(void)
{
    xSemaphoreTake(s_led_mtx, portMAX_DELAY);
    s_led_mode = LED_MODE_OFFLINE;
    xSemaphoreGive(s_led_mtx);
}

void fx_set_agent_state(deck_state_t state)
{
    xSemaphoreTake(s_led_mtx, portMAX_DELAY);
    if (state != DECK_STATE_DEMO) s_agent_state = state;   /* demo 不改基准状态 */
    led_apply_agent_state(state);
    xSemaphoreGive(s_led_mtx);
    ESP_LOGD(TAG, "LED 状态机 → %d", state);
}

void fx_demo_start(void)
{
    fx_set_agent_state(DECK_STATE_DEMO);   /* 七彩呼吸 3s */
    fx_play(FX_DEMO);                       /* 魂斗罗 riff */
}

#define FX_IDLE_POLL_MS 10   /* 空转轮询周期 = 刻度音最大延迟 */

static void fx_task(void *arg)
{
    static note_t notes[RTTTL_MAX_NOTES];
    fx_melody_t id;
    for (;;) {
        /* 刻度音优先: 10ms 轮询一次, 人手旋转的反馈要在半帧内出声 */
        if (click_drain()) {
            continue;
        }
        if (xQueueReceive(s_fx.requests, &id, pdMS_TO_TICKS(FX_IDLE_POLL_MS)) != pdTRUE) continue;
        if (id >= FX_COUNT) continue;

        if (config_get()->muted && id != FX_MUTED_OFF) {
            /* 静音中只放行"关闭静音"的确认音 */
            ESP_LOGD(TAG, "静音中, 跳过 %d", id);
            continue;
        }
        const int count = rtttl_parse(s_melodies[id], notes, RTTTL_MAX_NOTES);
        if (count < 0) {
            ESP_LOGE(TAG, "RTTTL 解析失败 (%d): %s", count, s_melodies[id]);
            continue;
        }
        ESP_LOGD(TAG, "播放 %d (%d 音符)", id, count);
        play_notes(notes, count);
    }
}


/* ---------------- 公共 API ---------------- */
void fx_play(fx_melody_t id)
{
    if (id >= FX_COUNT) return;
    if (xQueueSend(s_fx.requests, &id, 0) != pdTRUE) {
        ESP_LOGW(TAG, "fx 队列满, 丢弃 %d", id);
    }
}

void fx_encoder_click(int32_t dir)
{
    if (dir == 0 || config_get()->muted || !config_get()->click_sound) return;

    const int8_t d = dir > 0 ? 1 : -1;
    const int64_t now = esp_timer_get_time();

    /* 同一格的 4 个正交跳变合并成一次发声; 换向则立刻放行, 手一抖也能听见 */
    if (d == s_fx.last_click_dir &&
        now - s_fx.last_click_us < CLICK_GAP_MS * 1000) {
        return;
    }
    s_fx.last_click_dir = d;
    s_fx.last_click_us = now;
    if (xQueueSend(s_fx.clicks, &d, 0) != pdTRUE) {
        ESP_LOGD(TAG, "刻度音积压, 丢弃 %+d", d);
    }
}

void fx_set_muted(bool muted)
{
    config_set_muted(muted);        /* 改配置 = 立即生效 (buzzer_hw 每次读) */
    if (muted) {
        buzzer_hw(false);   /* 掐断当前正在响的音符 */
        click_flush();      /* 静音瞬间的待播刻度音一并作废 */
    }
}

bool fx_is_muted(void)
{
    return config_get()->muted;
}

void fx_set_click_enabled(bool on)
{
    config_set_click_sound(on);     /* 下一格起生效, 无需打断当前刻度音 */
    if (!on) click_flush();
}

bool fx_is_click_enabled(void)
{
    return config_get()->click_sound;
}

void fx_set_volume(uint8_t pct)
{
    config_set_volume(pct);         /* 下一音符起生效 */
    if (config_get()->volume == 0) buzzer_hw(false);
}

uint8_t fx_get_volume(void)
{
    return config_get()->volume;
}

void fx_set_brightness(uint8_t pct)
{
    config_set_brightness(pct);     /* led 任务下一 tick (≤100ms) 刷新 */
}

uint8_t fx_get_brightness(void)
{
    return config_get()->brightness;
}

void fx_led_set(uint8_t r, uint8_t g, uint8_t b)
{
    xSemaphoreTake(s_led_mtx, portMAX_DELAY);
    ESP_ERROR_CHECK(led_strip_set_pixel(s_fx.led, 0, r, g, b));
    ESP_ERROR_CHECK(led_strip_refresh(s_fx.led));
    xSemaphoreGive(s_led_mtx);
}

void fx_init(void)
{
    memset(&s_fx, 0, sizeof(s_fx));

    /* IO3 (WS2812 DIN) 上电即拉低: 浮空时射频/噪声会被 WS2812 当数据采样 */
    gpio_reset_pin(LED_GPIO);
    gpio_set_direction(LED_GPIO, GPIO_MODE_OUTPUT);
    gpio_set_level(LED_GPIO, 0);

    /* 蜂鸣器: LEDC PWM */
    const ledc_timer_config_t timer = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = LEDC_TIMER_10_BIT,
        .timer_num = LEDC_TIMER_0,
        .freq_hz = 1000,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&timer));
    const ledc_channel_config_t ch = {
        .gpio_num = BUZZER_GPIO,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = LEDC_CHANNEL_0,
        .timer_sel = LEDC_TIMER_0,
        .duty = 0,
    };
    ESP_ERROR_CHECK(ledc_channel_config(&ch));

    /* WS2812: C2 无 RMT, 走 SPI 后端; led_strip 内部自行初始化 SPI 总线 */
    const led_strip_config_t strip = {
        .strip_gpio_num = LED_GPIO,
        .max_leds = 1,
        .led_pixel_format = LED_PIXEL_FORMAT_GRB,
        .led_model = LED_MODEL_WS2812,
    };
    const led_strip_spi_config_t spi = {
        .clk_src = SPI_CLK_SRC_DEFAULT,
        .spi_bus = SPI2_HOST,
        .flags.with_dma = false,
    };
    ESP_ERROR_CHECK(led_strip_new_spi_device(&strip, &spi, &s_fx.led));
    led_strip_clear(s_fx.led);

    s_fx.requests = xQueueCreate(FX_QUEUE_LEN, sizeof(fx_melody_t));
    s_fx.clicks = xQueueCreate(CLICK_QUEUE_LEN, sizeof(int8_t));
    s_led_mtx = xSemaphoreCreateMutex();
    xTaskCreate(fx_task, "fx", 3072, NULL, 5, NULL);
    xTaskCreate(led_task, "led", 3072, NULL, 4, NULL);
    ESP_LOGI(TAG, "fx 引擎就绪 (buzzer=IO%d led=IO%d 音量=%u%% 亮度=%u%%)",
             BUZZER_GPIO, LED_GPIO, config_get()->volume, config_get()->brightness);
}

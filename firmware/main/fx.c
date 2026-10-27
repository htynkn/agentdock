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
#include "freertos/task.h"
#include "led_strip.h"
#include "led_strip_spi.h"

#include "deck.h"

static const char *TAG = "fx";

#define BUZZER_GPIO      1
#define LED_GPIO         3
#define GAP_MS           15      /* 音符间断句, 避免连音 */
#define FX_QUEUE_LEN     4

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
};
_Static_assert(sizeof(s_melodies) / sizeof(s_melodies[0]) == FX_COUNT, "旋律表与枚举不齐");

/* ---------------- 状态与任务 ---------------- */
typedef struct {
    led_strip_handle_t led;
    QueueHandle_t requests;
    volatile bool muted;
} fx_ctx_t;

static fx_ctx_t s_fx;

static void buzzer_hw(bool on)
{
    /* duty 0 = MOSFET 关断, 物理静音 */
    ESP_ERROR_CHECK(ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, on ? 512 : 0));
    ESP_ERROR_CHECK(ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0));
}

static void play_notes(const note_t *notes, int count)
{
    for (int i = 0; i < count; i++) {
        if (notes[i].freq_hz > 0 && !s_fx.muted) {
            ESP_ERROR_CHECK(ledc_set_freq(LEDC_LOW_SPEED_MODE, LEDC_TIMER_0, notes[i].freq_hz));
            buzzer_hw(true);
        }
        vTaskDelay(pdMS_TO_TICKS(notes[i].ms));
        buzzer_hw(false);
        vTaskDelay(pdMS_TO_TICKS(GAP_MS));
    }
}

/* ---------------- LED 状态机 ---------------- */
typedef enum {
    LED_MODE_OFFLINE,    /* 未连接: 每 1s 极暗蓝光心跳 */
    LED_MODE_STATIC,     /* 常亮 (idle 蓝) */
    LED_MODE_BREATHING,  /* 呼吸 (busy 绿) */
    LED_MODE_FLASH_N,    /* 闪 N 次后回 base (done/error) */
} led_mode_t;

static volatile led_mode_t s_led_mode = LED_MODE_OFFLINE;
static uint8_t s_led_base[3] = { 0, 0, 40 };      /* idle 蓝 (微亮) */
static uint8_t s_led_active[3] = { 0, 0, 0 };
static int s_led_flashes_left = 0;
static bool s_led_flash_on = false;   /* FLASH_N 相位: true=亮(active) false=灭(黑) */
static volatile bool s_led_on = false;
static int64_t s_led_next_at = 0;
#define LED_TICK_MS 100

static void apply_led(void)
{
    uint8_t r = 0, g = 0, b = 0;
    switch (s_led_mode) {
    case LED_MODE_BREATHING: {
        /* 2s 周期呼吸: 用 100ms tick 近似正弦 (6 段阶梯) */
        static const uint8_t breath[10] = { 4, 8, 14, 20, 24, 26, 24, 20, 14, 8 };
        static int phase = 0;
        r = s_led_active[0] * breath[phase] / 32;
        g = s_led_active[1] * breath[phase] / 32;
        b = s_led_active[2] * breath[phase] / 32;
        phase = (phase + 1) % 10;
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
    static uint8_t last[3] = { 0xFF, 0xFF, 0xFF };
    if (last[0] == r && last[1] == g && last[2] == b) return;   /* 无变化不刷 SPI */
    last[0] = r; last[1] = g; last[2] = b;
    ESP_ERROR_CHECK(led_strip_set_pixel(s_fx.led, 0, r, g, b));
    ESP_ERROR_CHECK(led_strip_refresh(s_fx.led));
}

void fx_set_offline(void)
{
    s_led_mode = LED_MODE_OFFLINE;
}

void fx_set_agent_state(deck_state_t state)
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
    default:
        break;
    }
    s_led_next_at = 0;   /* 立即生效 */
    ESP_LOGD(TAG, "LED 状态机 → %d", state);
}

static void fx_task(void *arg)
{
    static note_t notes[RTTTL_MAX_NOTES];
    fx_melody_t id;
    for (;;) {
        /* LED 状态机 tick (100ms), 有按键请求时优先 */
        const int64_t now = esp_timer_get_time();
        if (now >= s_led_next_at) {
            s_led_next_at = now + LED_TICK_MS * 1000;
            apply_led();
        }
        if (xQueueReceive(s_fx.requests, &id, pdMS_TO_TICKS(LED_TICK_MS)) != pdTRUE) continue;
        if (id >= FX_COUNT) continue;

        if (s_fx.muted && id != FX_MUTED_OFF) {
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

void fx_set_muted(bool muted)
{
    s_fx.muted = muted;
    if (muted) buzzer_hw(false);   /* 掐断当前正在响的音符 */
}

bool fx_is_muted(void)
{
    return s_fx.muted;
}

void fx_led_set(uint8_t r, uint8_t g, uint8_t b)
{
    ESP_ERROR_CHECK(led_strip_set_pixel(s_fx.led, 0, r, g, b));
    ESP_ERROR_CHECK(led_strip_refresh(s_fx.led));
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
    xTaskCreate(fx_task, "fx", 3072, NULL, 5, NULL);
    ESP_LOGI(TAG, "fx 引擎就绪 (buzzer=IO%d led=IO%d)", BUZZER_GPIO, LED_GPIO);
}

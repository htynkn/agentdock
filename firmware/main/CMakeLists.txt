idf_component_register(SRCS "main.c" "input.c" "deck.c" "fx.c" "config.c"
                       INCLUDE_DIRS "."
                       PRIV_REQUIRES bt driver nvs_flash esp_timer led_strip)

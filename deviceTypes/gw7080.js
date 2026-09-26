// gw7080 cellular gateway (Sep 2026).
//
// Its own readings arrive on dev/{guid}/data (not retained) and map through dataMap. Its retained
// dev/{guid}/status is connectivity only (connect event, csq, ipa, firmware, nwinfo, reboot info), so
// statusMap stays empty and status updates only last seen and firmware (pipeline/identify.js).
// Config values (dev/{guid}/config/{key}) and geoscan are accepted and logged, not stored yet.
// Relayed frames go through the node's own type, not this one.
//
// Sensors are created per channel when its first value arrives (services/devices.createSensor).
// Default alarms are per channel: only vin carries a no-data rule, since every data message
// carries vin.
module.exports =
{
    slug: "gw7080",
    displayName: "GW7080 gateway",
    kind: "gateway",
    dedupMode: "none",
    minIntervalSecs: 0,
    models: ["gw7080"],     // exact model string the firmware sends in its provisioning request
    fields: [],
    statusMap: {},
    // Firmware key (publishStatus in publish_handler.cpp, unchanged) -> channel id (the naming
    // standard, DECISIONS). Nulls (no SHTC3, board 1.1 charge fields) skip. batt_pct is not sent by
    // the device: int-vbat-pct and signal are computed on the server (services/levels.js).
    dataMap:
    {
        cycles: "cycles",
        vin: "vin",
        vbat: "int-vbat",
        int_temp: "int-temp",
        int_hum: "int-humidity",
        modem_csq: "csq",
        wifi_rssi: "wifi-rssi",
        run_time: "run-time",
        free_heap: "free-heap",
        charge_state: "charge-state",
        charge_adc: "charge-adc",
        charge_disable: "charge-disable",
        charge_disable_remaining_m: "charge-disable-remaining",
        charge_disable_src: "charge-disable-src",
        wifiap_clients: "wifiap-clients",
        // Sent once per boot in the reboot message, not in the periodic payload.
        reboot_reason: "reboot-reason",
        reboot_count: "reboot-count",
        is_secure: "is-secure"
    },
    // Default for int-vbat-pct; a device can override it on its Settings tab. PROVISIONAL table.
    batteryChemistry: "li_ion",
    channels:
    [
        { id: "vin", name: "External Vin", metric: "voltage", inboundUnit: "V",
          defaultAlarms:
          [
              { direction: "lower", threshold: 10.5, severity: "warning", exceedSecs: 600, returnSecs: 600 },
              { rule: "no_data", timeoutSecs: 3600 }
          ] },
        { id: "int-vbat", name: "Battery voltage", metric: "voltage", inboundUnit: "V",
          defaultAlarms: [{ direction: "lower", threshold: 3.5, severity: "warning", exceedSecs: 600, returnSecs: 600 }] },
        { id: "int-vbat-pct", name: "Battery", metric: "percent" },
        { id: "int-temp", name: "Board temperature", metric: "temperature", inboundUnit: "C" },
        { id: "int-humidity", name: "Board humidity", metric: "humidity", inboundUnit: "%" },
        // The gateway's own radio: csq on cellular, wifi-rssi on WiFi (one or the other per message),
        // and signal, the percent from whichever arrived (services/levels.js).
        { id: "signal", name: "Signal", metric: "percent" },
        { id: "csq", name: "Cellular signal (CSQ)", metric: "count", signal: "csq" },
        { id: "wifi-rssi", name: "WiFi signal", metric: "rssi", inboundUnit: "dBm", signal: "wifi" },
        { id: "run-time", name: "Uptime", metric: "duration", inboundUnit: "min", displayUnit: "h" },
        { id: "free-heap", name: "Free heap", metric: "data_size", inboundUnit: "B", displayUnit: "kB" },
        { id: "cycles", name: "Publish cycles", metric: "count" },
        { id: "charge-state", name: "Charge state", metric: "count" },
        { id: "charge-adc", name: "Charge ADC", metric: "count" },
        { id: "charge-disable", name: "Charging disabled", metric: "boolean" },
        { id: "charge-disable-remaining", name: "Charge disable remaining", metric: "duration", inboundUnit: "min", displayUnit: "min" },
        { id: "charge-disable-src", name: "Charge disable source", metric: "count" },
        { id: "wifiap-clients", name: "WiFi AP clients", metric: "count" },
        // Once per boot: no no-data rule, a quiet gateway is a good one.
        { id: "reboot-reason", name: "Reboot reason", metric: "count" },
        { id: "reboot-count", name: "Reboot count", metric: "count" },
        { id: "is-secure", name: "Secure connection", metric: "boolean" }
    ],
    // Gateway config keys (dev/{guid}/config/{key} up, cmd/set_config/{key} down), from the
    // firmware's mqtt_handler.cpp and the old PHP gateway model. The config page, the save route and
    // validation all read this table, so changing a key is an edit here only:
    //   writable  false shows the value read only; flip to true to allow writes from the page
    //   advanced  shown under "Advanced" on the page (the old PHP d-none keys)
    //   kind      how values are validated and compared with what the gateway echoes back:
    //             string | int | float (decimals, the firmware prints %.1f) | bool | hexlist
    //   confirm   the page asks before saving (keys that can strand or reboot the gateway)
    //   maxLength, min, max  from the EEPROM_CONFIGS struct in the firmware's config.h (char[n] holds
    //             n - 1 characters; byte 0..255, uint16_t 0..65535)
    // Reported keys not listed here still show, read only.
    configKeys:
    {
        ssid:                                  { label: "WiFi SSID", kind: "string", maxLength: 31, writable: true, description: "WiFi network the gateway joins" },
        psk:                                   { label: "WiFi password", kind: "string", maxLength: 62, writable: true, description: "Password for the WiFi network" },
        connectivity_mode:                     { label: "Connectivity mode", kind: "int", min: 1, max: 3, writable: true, description: "1 modem only, 2 WiFi only, 3 WiFi then modem" },
        apn_name:                              { label: "APN name", kind: "string", maxLength: 15, writable: true, description: "Usually hologram" },
        endpoint_host:                         { label: "Broker host", kind: "string", maxLength: 49, writable: true, description: "Domain only, no http or https",
                                                 confirm: "A wrong host strands the gateway: it can no longer reach the server to be corrected." },
        endpoint_port:                         { label: "Broker port", kind: "int", writable: true, min: 1, max: 65535, description: "Usually 8883",
                                                 confirm: "A wrong port strands the gateway: it can no longer reach the server to be corrected." },
        mqtt_keep_alive_interval_minutes:      { label: "MQTT keep alive minutes", kind: "int", writable: true, min: 0, max: 65535, description: "Usually 1" },
        normal_publish_interval_minutes:       { label: "Gateway publish minutes", kind: "int", writable: true, min: 1 },
        ble_enabled:                           { label: "BLE enabled", kind: "bool", writable: true, description: "Enable or disable BLE scanning" },
        ble_publish_interval_minutes:          { label: "Beacon publish minutes", kind: "int", writable: true, min: 1, max: 65535 },
        ble_priority_publish_interval_minutes: { label: "Beacon publish minutes, 0x22 beacons", kind: "int", writable: true, min: 1, max: 65535 },
        ble_filter_frame_types:                { label: "BLE filter frame types", kind: "hexlist", writable: true, description: "Comma separated hex frame types, usually 21,22" },
        ble_relay_mode:                        { label: "BLE relay mode", kind: "bool", writable: true, description: "Relay BLE over LoRa",
                                                 confirm: "Changing relay mode reboots the gateway. It confirms the new value after it reconnects." },
        rf_channel:                            { label: "RF channel", kind: "int", writable: true, min: 0, max: 255 },
        auto_charge_care_hours:                { label: "Auto charge care hours", kind: "int", writable: true, min: 0, max: 65535, description: "If vbat has not discharged to 3.8 V within this time the gateway forces a discharge. 0 disables." },
        empty_ack_delay_ms:                    { label: "Empty ack delay ms", kind: "int", writable: true, min: 0, max: 65535, description: "Maximum random delay when no message is queued, so a gateway with a queued message wins the ack race. 600 to 1000, 800 is ideal. 0 disables." },
        wifi_ap_enabled:                       { label: "WiFi AP enabled", kind: "bool", writable: true, advanced: true, description: "Access point so the gateway can act as a simple router, usually for a single device" },
        wifi_ap_ssid:                          { label: "WiFi AP name", kind: "string", maxLength: 31, writable: true, advanced: true, description: "e.g. iot-wifi-ap" },
        wifi_ap_password:                      { label: "WiFi AP password", kind: "string", maxLength: 62, writable: true, advanced: true, description: "Empty for an open network" },
        wifi_ap_hidden:                        { label: "WiFi AP hidden", kind: "bool", writable: true, advanced: true, description: "Hide the access point name" },
        rf_network:                            { label: "RF network", kind: "int", min: 0, max: 255, writable: false },
        rf_node_id:                            { label: "RF node id", kind: "int", min: 0, max: 255, writable: false },
        rf_mode_config:                        { label: "RF mode", kind: "int", min: 0, max: 255, writable: false },
        rf_network_mode:                       { label: "RF network mode", kind: "int", min: 0, max: 255, writable: false, description: "0 NOP, 1 promiscuous" },
        base_radio_freq:                       { label: "Base radio frequency", kind: "float", decimals: 1, writable: false },
        board_rev:                             { label: "Board rev", kind: "string", writable: false },
        cfg_sense_adc:                         { label: "Config ADC sense raw", kind: "int", writable: false },
        temp_sensor:                           { label: "Temperature sensor", kind: "string", writable: false }
    },
    // Commands on the device Commands tab (POST /devices/:uid/commands). Each is published to
    // dev/{guid}/cmd/{name} using the firmware's own command name (mqtt_handler.cpp), not retained
    // and not queued: an offline gateway never gets it. Adding a command is an entry here:
    //   label         button text; users see this, not the firmware name
    //   permission    the permission bit a user needs to see and send it (tab hides with none)
    //   confirm       the page asks before sending (commands that disrupt the gateway)
    //   cooldownSecs  minimum time between two sends to one device, from any user or farm server
    //   payload       optional, sent as is; most commands ignore it
    commands:
    {
        publish_now: { label: "Get data", permission: "view", confirm: false, cooldownSecs: 60, description: "The gateway publishes its current readings and the BLE beacons it has heard. New values show on the Sensors tab as they arrive." },
        reboot:      { label: "Reboot", permission: "edit", confirm: true, cooldownSecs: 120, description: "The gateway restarts. It is offline for a minute or two while it reconnects, and readings from its nodes are missed until it is back." }
    },
    hooks: {}
};

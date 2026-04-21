# Bestway Lay-Z-Spa for Homey

Control your Bestway Lay-Z-Spa hot tub directly from Homey. The app connects to the Bestway Smart Hub cloud (Gizwits API) and keeps the device state in sync automatically.

Tested with the Hydrojet SPA Heater with WIFI as used in the Bestway® LAY-Z-SPA® Dominica HydroJet™ Energy Plus whirlpool with app control.

---

## Supported Models

| API Product Name | Device Generation |
|---|---|
| `Airjet` | Basic AirJet spa (e.g. Miami, Monaco) |
| `Airjet_V01` | V01 AirJet spa (e.g. Helsinki, Paris) |
| `Hydrojet` | HydroJet spa |
| `Hydrojet_Pro` | HydroJet Pro spa (e.g. Dominica HydroJet™ Energy Plus) |

> **Note:** V02 models (Airjet V02, Hydrojet V02, etc.) use a different AWS IoT backend and are not supported.

---

## Features

### Device Controls
- **Power** — Turn the spa on and off
- **Target temperature** — Set the desired water temperature (20–40 °C, 1 °C steps)
- **AirJet Low / High** — Set bubble massage intensity (Low or High; mutually exclusive)
- **HydroJet** — Toggle water jet massage on/off (HydroJet models only)
- **Filter** — Run or stop the filter pump independently
- **Heating** — Toggle the heater on/off independently
- **Panel Lock** — Read-only display of the physical keypad lock state

### Status Display
- **Current water temperature** — Live reading from the device sensor
- **Target temperature reached** — Indicator when the set temperature has been reached (E32)
- **Error alarm** — Generic alarm flag when any fault code is active
- **Error details** — Human-readable description of active error codes (E01–E31)

### Flow Cards

**Triggers (When…)**
- Target temperature reached *(token: current temperature in °C)*
- Spa error occurred *(token: error message)*

**Conditions (And…)**
- Heating is / is not active
- Filter is / is not running
- Spa has / has no error
- Water temperature is above / not above `[x]` °C
- Water temperature is below / not below `[x]` °C
- Target temperature is / is not reached
- AirJet is / is not active

**Actions (Then…)**
- Set AirJet level *(Off / Low / High)*
- Turn HydroJet on or off
- Turn heating on or off
- Turn filter on or off

### Automation
All controls are available as Flow cards, so you can build automations such as:
- Heat the spa to target temperature before you arrive home
- Send a notification when the target temperature is reached
- Turn off the filter at night and back on in the morning
- Alert when a spa error code is detected

---

## Settings

| Setting | Description |
|---|---|
| **Poll interval** | How often the app fetches status from the cloud (10–300 s, default 30 s). Shorter intervals give faster updates but increase cloud traffic. |
| **Server region** | Gizwits API region (EU / US / Global). Set automatically during pairing; only change if login fails. |

### Troubleshooting Panel
A read-only panel in the device settings shows live diagnostic data after every sync:

| Field | Content |
|---|---|
| Last sync | Timestamp of the last successful or failed API call |
| Status | `OK ✓` or `Error: <message>` |
| Device model | `product_name` as reported by the Gizwits API |
| Active region | The region currently used for API calls |
| Active error codes | Raw E-codes with non-zero values (E01–E31) |
| Raw device attributes | All raw key/value pairs from the API response |

---

## Pairing

1. Open the Homey app → **Devices** → **+** → search for *Lay-Z-Spa*
2. Sign in with your **Bestway Smart Hub** account (email + password)
3. Select your spa from the list — offline devices are marked *(offline)*
4. The device is added and starts syncing automatically

### Credential Repair
If your Bestway password changes, use **Device → Settings → Repair** to update the credentials without removing and re-adding the device.

---

## Error Codes

| Code | Meaning |
|---|---|
| E01 | Flow sensor error (paddle stuck) |
| E02 | Insufficient water flow |
| E03 | Water temperature too low (< 4 °C) |
| E04 | Water temperature too high (> 48 °C) |
| E05 | Temperature sensor error |
| E06 | Pump test failed |
| E08 | Thermal cutoff triggered (> 55 °C) |
| E32 | Target temperature reached *(not a fault — shown as "Temp reached" indicator)* |

---

## Technical Details

- **API:** Bestway / Gizwits V01 REST API
- **Regions:** EU (`euapi.gizwits.com`), US (`usapi.gizwits.com`), Global (`api.gizwits.com`)
- **Authentication:** Token-based with automatic refresh before expiry
- **Polling:** Configurable interval with exponential backoff on failure (doubles per failure, max 5 min)
- **Control retry:** Failed commands are retried once after 2 seconds
- **Homey SDK:** v3, Homey ≥ 12.0.0

---

## Contributing & Credits

Pull requests welcome. API mapping based on analysis of the [ha-bestway](https://github.com/cdpuk/ha-bestway) Home Assistant integration.

Bugs and feature requests: [GitHub Issues](https://github.com/andiwirz/com.bestway.layzspa/issues)

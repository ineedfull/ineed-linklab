// Serial line and receive-framing configuration validation.
use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DataBits {
    Five,
    Six,
    Seven,
    Eight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Parity {
    None,
    Odd,
    Even,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StopBits {
    One,
    Two,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FlowControl {
    None,
    Software,
    Hardware,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ReceiveFraming {
    Raw,
    Delimiter(Vec<u8>),
    Fixed(usize),
    Idle(Duration),
}

impl ReceiveFraming {
    pub(crate) fn from_config(value: Option<&Value>) -> SerialResult<Self> {
        let Some(value) = value else {
            return Ok(Self::Raw);
        };
        let object = value
            .as_object()
            .ok_or_else(|| config_error("receiveFraming must be an object"))?;
        let mode = object
            .get("mode")
            .and_then(Value::as_str)
            .ok_or_else(|| config_error("receiveFraming.mode must be a string"))?;
        match mode {
            "raw" if object.len() == 1 => Ok(Self::Raw),
            "delimiter" if object.len() == 2 => {
                let values = object
                    .get("delimiterBytes")
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        config_error("receiveFraming.delimiterBytes must be an array")
                    })?;
                if values.is_empty() {
                    return Err(config_error(
                        "receiveFraming.delimiterBytes must be nonempty",
                    ));
                }
                let mut bytes = Vec::with_capacity(values.len());
                for value in values {
                    let byte = value.as_u64().filter(|byte| *byte <= 255).ok_or_else(|| {
                        config_error("receiveFraming.delimiterBytes contains an invalid byte")
                    })?;
                    bytes.push(byte as u8);
                }
                Ok(Self::Delimiter(bytes))
            }
            "fixed" if object.len() == 2 => {
                let length = object
                    .get("length")
                    .and_then(Value::as_u64)
                    .filter(|length| *length > 0 && *length <= usize::MAX as u64)
                    .ok_or_else(|| {
                        config_error("receiveFraming.length must be a positive integer")
                    })?;
                Ok(Self::Fixed(length as usize))
            }
            "idle" if object.len() == 2 => {
                let idle_ms = object
                    .get("idleMs")
                    .and_then(Value::as_u64)
                    .filter(|idle_ms| *idle_ms > 0)
                    .ok_or_else(|| {
                        config_error("receiveFraming.idleMs must be a positive integer")
                    })?;
                Ok(Self::Idle(Duration::from_millis(idle_ms)))
            }
            "raw" | "delimiter" | "fixed" | "idle" => {
                Err(config_error("receiveFraming has unknown or missing fields"))
            }
            _ => Err(config_error("receiveFraming.mode is invalid")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SerialConfig {
    pub(crate) path: String,
    pub(crate) baud_rate: u32,
    pub(crate) data_bits: DataBits,
    pub(crate) parity: Parity,
    pub(crate) stop_bits: StopBits,
    pub(crate) flow_control: FlowControl,
    pub(crate) receive_framing: ReceiveFraming,
}

impl SerialConfig {
    pub(crate) fn from_value(value: &Value) -> SerialResult<Self> {
        let object = value
            .as_object()
            .ok_or_else(|| config_error("serial config must be an object"))?;
        let path = object
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .ok_or_else(|| config_error("config.path must be a nonblank string"))?
            .to_owned();
        let baud_rate = object
            .get("baudRate")
            .and_then(Value::as_u64)
            .filter(|rate| *rate > 0 && *rate <= u32::MAX as u64)
            .ok_or_else(|| config_error("config.baudRate must be a positive integer"))?
            as u32;
        let data_bits = match object.get("dataBits").and_then(Value::as_u64) {
            Some(5) => DataBits::Five,
            Some(6) => DataBits::Six,
            Some(7) => DataBits::Seven,
            Some(8) => DataBits::Eight,
            _ => return Err(config_error("config.dataBits must be 5, 6, 7, or 8")),
        };
        let parity = match object.get("parity").and_then(Value::as_str) {
            Some("none") => Parity::None,
            Some("odd") => Parity::Odd,
            Some("even") => Parity::Even,
            Some("mark" | "space") => {
                return Err(config_error(
                    "serialport 4.9 does not support mark or space parity",
                ));
            }
            _ => return Err(config_error("config.parity must be none, odd, or even")),
        };
        let stop_bits = match object.get("stopBits") {
            Some(Value::Number(number)) if number.as_u64() == Some(1) => StopBits::One,
            Some(Value::Number(number)) if number.as_u64() == Some(2) => StopBits::Two,
            Some(Value::Number(number)) if number.as_f64() == Some(1.5) => {
                return Err(config_error(
                    "serialport 4.9 does not support 1.5 stop bits",
                ));
            }
            _ => return Err(config_error("config.stopBits must be 1 or 2")),
        };
        let flow_control = match object.get("flowControl").and_then(Value::as_str) {
            Some("none") => FlowControl::None,
            Some("software") => FlowControl::Software,
            Some("hardware") => FlowControl::Hardware,
            _ => {
                return Err(config_error(
                    "config.flowControl must be none, software, or hardware",
                ));
            }
        };
        Ok(Self {
            path,
            baud_rate,
            data_bits,
            parity,
            stop_bits,
            flow_control,
            receive_framing: ReceiveFraming::from_config(object.get("receiveFraming"))?,
        })
    }
}

// TCP/RTU frame extraction and request/response PDU conversion.
use super::*;

pub(super) fn take_tcp_frames(buffer: &mut Vec<u8>) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();
    loop {
        if buffer.len() < 6 {
            break;
        }
        let body_length = u16::from_be_bytes([buffer[4], buffer[5]]) as usize;
        if !(2..=254).contains(&body_length) {
            buffer.clear();
            break;
        }
        let frame_length = 6 + body_length;
        if buffer.len() < frame_length {
            break;
        }
        frames.push(buffer.drain(..frame_length).collect());
    }
    frames
}

pub(super) fn take_rtu_request_frame(buffer: &mut Vec<u8>) -> Option<Vec<u8>> {
    loop {
        if buffer.len() < 2 {
            return None;
        }
        let frame_length = match buffer[1] {
            1..=6 => 8,
            15 | 16 => {
                if buffer.len() < 7 {
                    return None;
                }
                let function_code = buffer[1];
                let quantity = u16::from_be_bytes([buffer[4], buffer[5]]);
                let byte_count = usize::from(buffer[6]);
                let valid_shape = if function_code == 15 {
                    (1..=1968).contains(&quantity)
                        && byte_count == usize::from(quantity).div_ceil(8)
                } else {
                    (1..=123).contains(&quantity) && byte_count == usize::from(quantity) * 2
                };
                if !valid_shape || 9 + byte_count > 256 {
                    buffer.remove(0);
                    continue;
                }
                9 + byte_count
            }
            _ => {
                buffer.remove(0);
                continue;
            }
        };
        if buffer.len() < frame_length {
            return None;
        }
        if valid_rtu_crc(&buffer[..frame_length]) {
            return Some(buffer.drain(..frame_length).collect());
        }
        buffer.remove(0);
    }
}

pub(super) fn valid_rtu_crc(frame: &[u8]) -> bool {
    if frame.len() < 4 {
        return false;
    }
    let checksum = modbus_crc16(&frame[..frame.len() - 2]);
    frame[frame.len() - 2..] == checksum.to_le_bytes()
}

pub(super) fn parse_rtu_request(frame: &[u8]) -> io::Result<SlaveRequest<'static>> {
    if frame.len() < 4 || !valid_rtu_crc(frame) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid Modbus RTU frame",
        ));
    }
    let pdu = &frame[1..frame.len() - 2];
    let function_code = pdu[0];
    let word_at = |offset: usize| -> io::Result<u16> {
        let bytes = pdu.get(offset..offset + 2).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "incomplete Modbus RTU PDU")
        })?;
        Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
    };
    let address = word_at(1)?;
    let quantity_or_value = word_at(3)?;
    let request = match function_code {
        1 if pdu.len() == 5 && (1..=2000).contains(&quantity_or_value) => {
            Request::ReadCoils(address, quantity_or_value)
        }
        2 if pdu.len() == 5 && (1..=2000).contains(&quantity_or_value) => {
            Request::ReadDiscreteInputs(address, quantity_or_value)
        }
        3 if pdu.len() == 5 && (1..=125).contains(&quantity_or_value) => {
            Request::ReadHoldingRegisters(address, quantity_or_value)
        }
        4 if pdu.len() == 5 && (1..=125).contains(&quantity_or_value) => {
            Request::ReadInputRegisters(address, quantity_or_value)
        }
        5 if pdu.len() == 5 && matches!(quantity_or_value, 0x0000 | 0xff00) => {
            Request::WriteSingleCoil(address, quantity_or_value == 0xff00)
        }
        6 if pdu.len() == 5 => Request::WriteSingleRegister(address, quantity_or_value),
        15 => {
            let byte_count = usize::from(*pdu.get(5).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "missing Modbus coil byte count")
            })?);
            if !(1..=1968).contains(&quantity_or_value)
                || pdu.len() != 6 + byte_count
                || byte_count != usize::from(quantity_or_value).div_ceil(8)
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid Modbus multiple-coil payload",
                ));
            }
            let values = (0..usize::from(quantity_or_value))
                .map(|index| pdu[6 + index / 8] & (1 << (index % 8)) != 0)
                .collect();
            Request::WriteMultipleCoils(address, Cow::Owned(values))
        }
        16 => {
            let byte_count = usize::from(*pdu.get(5).ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "missing Modbus register byte count",
                )
            })?);
            if !(1..=123).contains(&quantity_or_value)
                || pdu.len() != 6 + byte_count
                || byte_count != usize::from(quantity_or_value).saturating_mul(2)
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid Modbus multiple-register payload",
                ));
            }
            let values = pdu[6..]
                .chunks_exact(2)
                .map(|bytes| u16::from_be_bytes([bytes[0], bytes[1]]))
                .collect();
            Request::WriteMultipleRegisters(address, Cow::Owned(values))
        }
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unsupported Modbus RTU function",
            ));
        }
    };
    Ok(SlaveRequest {
        slave: frame[0],
        request,
    })
}

pub(super) fn response_to_rtu_pdu(response: Response) -> io::Result<Vec<u8>> {
    let pdu = match response {
        Response::ReadCoils(values) => {
            let packed = pack_bools(&values);
            let mut pdu = vec![1, packed.len() as u8];
            pdu.extend(packed);
            pdu
        }
        Response::ReadDiscreteInputs(values) => {
            let packed = pack_bools(&values);
            let mut pdu = vec![2, packed.len() as u8];
            pdu.extend(packed);
            pdu
        }
        Response::ReadHoldingRegisters(values) => register_response_pdu(3, &values),
        Response::ReadInputRegisters(values) => register_response_pdu(4, &values),
        Response::WriteSingleCoil(address, value) => {
            let mut pdu = vec![5];
            pdu.extend_from_slice(&address.to_be_bytes());
            pdu.extend_from_slice(if value { &[0xff, 0x00] } else { &[0x00, 0x00] });
            pdu
        }
        Response::WriteSingleRegister(address, value) => {
            let mut pdu = vec![6];
            pdu.extend_from_slice(&address.to_be_bytes());
            pdu.extend_from_slice(&value.to_be_bytes());
            pdu
        }
        Response::WriteMultipleCoils(address, quantity) => {
            write_multiple_response_pdu(15, address, quantity)
        }
        Response::WriteMultipleRegisters(address, quantity) => {
            write_multiple_response_pdu(16, address, quantity)
        }
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unsupported Modbus RTU response",
            ));
        }
    };
    Ok(pdu)
}

pub(super) fn register_response_pdu(function_code: u8, values: &[u16]) -> Vec<u8> {
    let mut pdu = vec![function_code, (values.len() * 2) as u8];
    for value in values {
        pdu.extend_from_slice(&value.to_be_bytes());
    }
    pdu
}

pub(super) fn write_multiple_response_pdu(
    function_code: u8,
    address: u16,
    quantity: u16,
) -> Vec<u8> {
    let mut pdu = vec![function_code];
    pdu.extend_from_slice(&address.to_be_bytes());
    pdu.extend_from_slice(&quantity.to_be_bytes());
    pdu
}

pub(super) fn pack_bools(values: &[bool]) -> Vec<u8> {
    values
        .chunks(8)
        .map(|chunk| {
            chunk.iter().enumerate().fold(
                0,
                |byte, (bit, value)| if *value { byte | (1 << bit) } else { byte },
            )
        })
        .collect()
}

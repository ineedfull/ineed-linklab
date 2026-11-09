use base64::{engine::general_purpose::STANDARD, Engine};
use opcua::types::*;
use serde_json::{json, Value};
use std::str::FromStr;

pub(super) fn parse_variant(kind: &str, array: &str, value: &Value) -> Result<Variant, String> {
    if array == "Array" {
        let values = value.as_array().ok_or("Array value must be an array")?;
        if values.len() > 10000 {
            return Err("Array exceeds 10000 elements".into());
        }
        let parsed: Vec<_> = values
            .iter()
            .map(|v| parse_variant(kind, "Scalar", v))
            .collect::<Result<_, _>>()?;
        let empty = match kind {
            "Boolean" => VariantScalarTypeId::Boolean,
            "SByte" => VariantScalarTypeId::SByte,
            "Byte" => VariantScalarTypeId::Byte,
            "Int16" => VariantScalarTypeId::Int16,
            "UInt16" => VariantScalarTypeId::UInt16,
            "Int32" => VariantScalarTypeId::Int32,
            "UInt32" => VariantScalarTypeId::UInt32,
            "Int64" => VariantScalarTypeId::Int64,
            "UInt64" => VariantScalarTypeId::UInt64,
            "Float" => VariantScalarTypeId::Float,
            "Double" => VariantScalarTypeId::Double,
            "String" => VariantScalarTypeId::String,
            "DateTime" => VariantScalarTypeId::DateTime,
            "ByteString" => VariantScalarTypeId::ByteString,
            "NodeId" => VariantScalarTypeId::NodeId,
            _ => return Err("Unsupported writable dataType".into()),
        };
        return Array::new(empty, parsed)
            .map(|a| Variant::Array(Box::new(a)))
            .map_err(|e| e.to_string());
    }
    if array != "Scalar" {
        return Err("arrayType must be Scalar or Array".into());
    }
    let invalid = || format!("Invalid or out-of-range {kind} value");
    macro_rules! signed {
        ($v:ident,$t:ty) => {
            Variant::$v(<$t>::try_from(value.as_i64().ok_or_else(invalid)?).map_err(|_| invalid())?)
        };
    }
    macro_rules! unsigned {
        ($v:ident,$t:ty) => {
            Variant::$v(<$t>::try_from(value.as_u64().ok_or_else(invalid)?).map_err(|_| invalid())?)
        };
    }
    let text = || value.as_str().ok_or_else(invalid);
    Ok(match kind {
        "Boolean" => Variant::Boolean(value.as_bool().ok_or_else(invalid)?),
        "SByte" => signed!(SByte, i8),
        "Byte" => unsigned!(Byte, u8),
        "Int16" => signed!(Int16, i16),
        "UInt16" => unsigned!(UInt16, u16),
        "Int32" => signed!(Int32, i32),
        "UInt32" => unsigned!(UInt32, u32),
        "Int64" => Variant::Int64(text()?.parse().map_err(|_| invalid())?),
        "UInt64" => Variant::UInt64(text()?.parse().map_err(|_| invalid())?),
        "Float" => {
            let n = value.as_f64().ok_or_else(invalid)? as f32;
            if !n.is_finite() {
                return Err(invalid());
            }
            Variant::Float(n)
        }
        "Double" => {
            let n = value.as_f64().ok_or_else(invalid)?;
            if !n.is_finite() {
                return Err(invalid());
            }
            Variant::Double(n)
        }
        "String" => Variant::String(text()?.into()),
        "DateTime" => {
            let parsed = chrono::DateTime::parse_from_rfc3339(text()?).map_err(|_| invalid())?;
            if parsed.timestamp() < -11644473600 {
                return Err(invalid());
            }
            let date = DateTime::parse_from_rfc3339(text()?).map_err(|_| invalid())?;
            if date < DateTime::epoch() {
                return Err(invalid());
            }
            Variant::DateTime(Box::new(date))
        }
        "ByteString" => Variant::ByteString(ByteString::from(
            STANDARD.decode(text()?).map_err(|_| invalid())?,
        )),
        "NodeId" => Variant::NodeId(Box::new(NodeId::from_str(text()?).map_err(|_| invalid())?)),
        _ => return Err("Unsupported writable dataType".into()),
    })
}
pub(super) fn variant_json(v: &Variant) -> Value {
    match v {
        Variant::Empty => Value::Null,
        Variant::Boolean(v) => json!(v),
        Variant::SByte(v) => json!(v),
        Variant::Byte(v) => json!(v),
        Variant::Int16(v) => json!(v),
        Variant::UInt16(v) => json!(v),
        Variant::Int32(v) => json!(v),
        Variant::UInt32(v) => json!(v),
        Variant::Int64(v) => json!(v.to_string()),
        Variant::UInt64(v) => json!(v.to_string()),
        Variant::Float(v) => json!(v),
        Variant::Double(v) => json!(v),
        Variant::String(v) => json!(v.value()),
        Variant::ByteString(v) => json!(v.value.as_ref().map(|bytes| STANDARD.encode(bytes))),
        Variant::DateTime(v) => json!(v.to_rfc3339()),
        Variant::NodeId(v) => json!(v.to_string()),
        Variant::Array(a) => json!(a.values.iter().map(variant_json).collect::<Vec<_>>()),
        _ => json!({"display":format!("{v:?}"),"readOnly":true}),
    }
}
pub(super) fn data_value(node_id: &str, v: &DataValue) -> Value {
    let variant = v.value.as_ref().unwrap_or(&Variant::Empty);
    let dimensions = match variant {
        Variant::Array(array) => array.dimensions.as_ref(),
        _ => None,
    };
    json!({"nodeId":node_id,"dataType":variant.scalar_type_id().map(|t|format!("{t:?}")).unwrap_or_else(||"Null".into()),"arrayType":if dimensions.is_some(){"Matrix"}else if variant.is_array(){"Array"}else{"Scalar"},"dimensions":dimensions,"value":variant_json(variant),"statusCode":v.status.unwrap_or(StatusCode::Good).to_string(),"sourceTimestamp":v.source_timestamp.as_ref().filter(|t|!t.is_null()).map(|t|t.to_rfc3339()),"serverTimestamp":v.server_timestamp.as_ref().filter(|t|!t.is_null()).map(|t|t.to_rfc3339())})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nullable_string_and_bytes_preserve_null_without_losing_empty_values() {
        assert_eq!(
            variant_json(&Variant::String(UAString::null())),
            Value::Null
        );
        assert_eq!(
            variant_json(&Variant::ByteString(ByteString::null())),
            Value::Null
        );
        assert_eq!(variant_json(&Variant::String("".into())), json!(""));
        assert_eq!(
            variant_json(&Variant::ByteString(ByteString::from(Vec::<u8>::new()))),
            json!("")
        );
    }
    #[test]
    fn matrix_rank_is_preserved_and_cannot_be_written_as_one_dimensional_array() {
        let matrix = Variant::Array(Box::new(
            Array::new_multi(
                VariantScalarTypeId::Int32,
                vec![
                    Variant::Int32(1),
                    Variant::Int32(2),
                    Variant::Int32(3),
                    Variant::Int32(4),
                ],
                vec![2, 2],
            )
            .unwrap(),
        ));
        let row = data_value(
            "ns=2;s=Matrix",
            &DataValue {
                value: Some(matrix),
                ..DataValue::null()
            },
        );
        assert_eq!(row["arrayType"], "Matrix");
        assert_eq!(row["dimensions"], json!([2, 2]));
        assert!(parse_variant("Int32", "Matrix", &row["value"]).is_err());
    }
}

//! Contract encoding: JSON and binary (`bincode`) round trips for every contract (`LOT-002`).

use super::*;

/// Errors raised during contract JSON or binary (`bincode`) serialization/deserialization.
#[derive(Debug, Error)]
pub enum ContractCodecError {
    #[error("JSON contract serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Binary contract serialization error: {0}")]
    Binary(#[from] bincode::Error),
    #[error("Failed to write generated TypeScript bindings: {0}")]
    Io(#[from] std::io::Error),
    #[error("Invalid editor IPC payload: {0}")]
    EditorIpc(String),
}

/// Serialize a contract to a JSON string.
pub fn encode_contract_json<T: Serialize>(value: &T) -> Result<String, ContractCodecError> {
    Ok(serde_json::to_string(value)?)
}

/// Deserialize a contract from a JSON string.
pub fn decode_contract_json<T: DeserializeOwned>(json: &str) -> Result<T, ContractCodecError> {
    Ok(serde_json::from_str(json)?)
}

/// Serialize a contract to a compact binary payload (`bincode`) for IPC channels.
pub fn encode_contract_binary<T: Serialize>(value: &T) -> Result<Vec<u8>, ContractCodecError> {
    Ok(bincode::serialize(value)?)
}

/// Deserialize a contract from a binary payload (`bincode`).
pub fn decode_contract_binary<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, ContractCodecError> {
    Ok(bincode::deserialize(bytes)?)
}

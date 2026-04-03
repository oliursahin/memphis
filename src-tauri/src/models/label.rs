use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub id: String,
    pub account_id: String,
    pub provider_label_id: String,
    pub name: String,
    pub color: Option<String>,
    pub label_type: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum SplitCategory {
    Important,
    Newsletter,
    Notification,
    Other,
}

impl SplitCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Important => "important",
            Self::Newsletter => "newsletter",
            Self::Notification => "notification",
            Self::Other => "other",
        }
    }
}

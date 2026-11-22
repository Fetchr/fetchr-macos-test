//! `tracing` layer that turns this crate's warnings and errors into reports.

use std::fmt::Write as _;

use serde_json::{json, Map, Value};
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::{Context, Layer};

use super::{Severity, Source};

const CRATE_PREFIX: &str = "fetchr_lib";
/// Modules whose own warnings would feed back into the reporter.
const SILENT_TARGETS: &[&str] = &["fetchr_lib::error_reports", "fetchr_lib::telemetry"];

pub struct ErrorReportLayer;

impl<S: Subscriber> Layer<S> for ErrorReportLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let metadata = event.metadata();
        // More verbose levels compare greater: this keeps WARN and ERROR.
        if *metadata.level() > Level::WARN {
            return;
        }
        let target = metadata.target();
        if !target.starts_with(CRATE_PREFIX)
            || SILENT_TARGETS.iter().any(|silent| target.starts_with(silent))
        {
            return;
        }
        let mut visitor = FieldCollector::default();
        event.record(&mut visitor);
        let severity = if *metadata.level() == Level::ERROR {
            Severity::Error
        } else {
            Severity::Warn
        };
        let module = target
            .trim_start_matches(CRATE_PREFIX)
            .trim_start_matches("::")
            .replace("::", ".");
        let mut context = Map::new();
        if let (Some(file), Some(line)) = (metadata.file(), metadata.line()) {
            context.insert("location".into(), json!(format!("{file}:{line}")));
        }
        if !visitor.fields.is_empty() {
            context.insert("fields".into(), Value::Object(visitor.fields));
        }
        super::report(
            Source::Tracing,
            severity,
            if module.is_empty() { "app".to_string() } else { module },
            &visitor.message,
            Value::Object(context),
        );
    }
}

#[derive(Default)]
struct FieldCollector {
    message: String,
    fields: Map<String, Value>,
}

impl Visit for FieldCollector {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.message, "{value:?}");
        } else {
            self.fields
                .insert(field.name().to_string(), json!(format!("{value:?}")));
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message.push_str(value);
        } else {
            self.fields.insert(field.name().to_string(), json!(value));
        }
    }
}

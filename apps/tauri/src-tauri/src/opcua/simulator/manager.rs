//! One address space owns reads, validated writes, snapshots, and subscriptions.
//! Using the SDK's external write callback would notify its old cached value.
use super::*;
use opcua::server::{
    address_space::{AddressSpace, NodeType},
    node_manager::{
        memory::{
            InMemoryNodeManager, InMemoryNodeManagerBuilder, InMemoryNodeManagerImpl,
            InMemoryNodeManagerImplBuilder,
        },
        RequestContext, ServerContext, WriteNode,
    },
};
use opcua::sync::RwLock;

pub(super) type Manager = InMemoryNodeManager<SimulatorAddressSpace>;
pub(super) fn builder(namespace: String) -> InMemoryNodeManagerBuilder<Builder> {
    InMemoryNodeManagerBuilder::new(Builder { namespace })
}
pub(super) struct Builder {
    namespace: String,
}
impl InMemoryNodeManagerImplBuilder for Builder {
    type Impl = SimulatorAddressSpace;
    fn build(self, context: ServerContext, address_space: &mut AddressSpace) -> Self::Impl {
        let namespace_index = context
            .type_tree
            .write()
            .namespaces_mut()
            .add_namespace(&self.namespace);
        address_space.add_namespace(&self.namespace, namespace_index);
        SimulatorAddressSpace {
            namespace: NamespaceMetadata {
                namespace_uri: self.namespace,
                namespace_index,
                ..Default::default()
            },
            specs: Mutex::new(HashMap::new()),
        }
    }
}
pub(super) struct SimulatorAddressSpace {
    namespace: NamespaceMetadata,
    specs: Mutex<HashMap<NodeId, Value>>,
}
impl SimulatorAddressSpace {
    pub(super) fn register(&self, id: NodeId, spec: Value) {
        self.specs.lock().unwrap().insert(id, spec);
    }
}
#[async_trait::async_trait]
impl InMemoryNodeManagerImpl for SimulatorAddressSpace {
    async fn init(&self, _address_space: &mut AddressSpace, _context: ServerContext) {}
    fn name(&self) -> &str {
        "LinkLab Simulator"
    }
    fn namespaces(&self) -> Vec<NamespaceMetadata> {
        vec![self.namespace.clone()]
    }
    async fn write(
        &self,
        context: &RequestContext,
        address_space: &RwLock<AddressSpace>,
        writes: &mut [&mut WriteNode],
    ) -> Result<(), StatusCode> {
        let mut address_space = address_space.write();
        let type_tree = context.type_tree.read();
        let specs = self.specs.lock().unwrap();
        for write in writes {
            let parsed = write.value();
            let status = (|| {
                let node = address_space.validate_node_write(context, parsed, &*type_tree)?;
                if parsed.attribute_id != AttributeId::Value {
                    return Err(StatusCode::BadNotWritable);
                }
                if !matches!(parsed.index_range, NumericRange::None) {
                    return Err(StatusCode::BadIndexRangeInvalid);
                }
                let spec = specs
                    .get(&parsed.node_id)
                    .ok_or(StatusCode::BadNodeIdUnknown)?;
                let incoming = parsed
                    .value
                    .value
                    .as_ref()
                    .ok_or(StatusCode::BadTypeMismatch)?;
                if incoming
                    .scalar_type_id()
                    .is_none_or(|kind| format!("{kind:?}") != spec["dataType"].as_str().unwrap())
                    || incoming.is_array() != (spec["arrayType"] == "Array")
                    || matches!(incoming,Variant::Array(a) if a.dimensions.is_some())
                {
                    return Err(StatusCode::BadTypeMismatch);
                }
                let value = validation::value(
                    spec["dataType"].as_str().unwrap(),
                    spec["arrayType"].as_str().unwrap(),
                    &super::super::value::variant_json(incoming),
                )
                .map_err(|_| StatusCode::BadOutOfRange)?;
                let NodeType::Variable(variable) = node else {
                    return Err(StatusCode::BadNotWritable);
                };
                let data = DataValue::new_now(value);
                variable.set_data_value(data.clone());
                context
                    .subscriptions
                    .notify_data_change([(data, &parsed.node_id, AttributeId::Value)].into_iter());
                Ok(())
            })();
            write.set_status(status.err().unwrap_or(StatusCode::Good));
        }
        Ok(())
    }
}
pub(super) fn read(manager: &Manager, id: &NodeId) -> Result<DataValue, String> {
    manager
        .address_space()
        .read()
        .find(id)
        .and_then(|n| {
            n.as_node().get_attribute(
                TimestampsToReturn::Both,
                AttributeId::Value,
                &NumericRange::None,
                &DataEncoding::Binary,
            )
        })
        .ok_or_else(|| "Missing simulator node value".into())
}

# S2 开发代码索引

扫描时间：2026-10-27T03:53:54.002Z。由 `scripts/inventory-scene-s2.ts` 生成。

本索引记录代码位置，不把文件存在等同于功能完成或测试通过。当前定位、抽包边界、真实验收范围和后续计划请先读 `docs/s2-development-handoff.md`；完整导出符号、导入依赖和SHA256见 `docs/s2-code-inventory.json`。

另一对话正在实施交互包改造，扫描完成后源码仍可能变化。此文件不移动源码，也不执行应用、测试、模型或资源读取。直接共享依赖不是整个应用依赖闭包，不能将本清单当作可分发插件包。

## S2 数据、画布、插件、业务指标与组合蓝图协议

4 个文件。

- `src/types/sceneS2.ts`：74 行。
  公开符号：`S2TableColumn`（5）、`S2ChartView`（6）、`S2Field`（7）、`S2BlockType`（14）、`S2Block`（20）、`S2Link`（21）、`S2InputBinding`（22）、`S2WorkflowCondition`（23）；其余 12 项见JSON清单。
- `src/types/sceneS2Business.ts`：36 行。
  公开符号：`S2BusinessCapability`（5）、`S2BusinessRule`（6）、`S2BusinessCriterion`（10）、`S2BusinessPackage`（20）。
- `src/types/sceneS2Composite.ts`：53 行。
  公开符号：`S2CompositeCapability`（4）、`S2CompositeEndpoint`（5）、`S2CompositeBlueprint`（7）、`S2CompositeValues`（18）、`S2CompositeExpansion`（25）、`S2CompositeInstanceMapping`（36）、`S2CanvasComposite`（40）、`S2CompositeDesign`（47）。
- `src/types/sceneS2Plugin.ts`：130 行。
  公开符号：`S2Json`（2）、`S2ValueSchema`（4）、`S2TypeRef`（11）、`S2DataType`（12）、`S2PluginPort`（13）、`S2PluginPermission`（14）、`S2PluginCapability`（15）、`S2PluginManifest`（29）；其余 11 项见JSON清单。

## 插件声明、注册、安装、数据协议、执行宿主和工作流

5 个文件。

- `src/services/scene/sceneS2PluginHost.ts`：1235 行。
  公开符号：`S2ModelWait`（31）、`S2_LOCAL_RUN_LIMIT`（33）、`S2ModelRequestDiagnostic`（34）、`S2ResourceReadDiagnostic`（35）、`S2FileSelectionDiagnostic`（36）、`S2WorkflowDiagnostic`（38）、`S2LocalExecution`（45）、`S2OutputIndexEntry`（53）；其余 4 项见JSON清单。
- `src/services/scene/sceneS2PluginInstallation.ts`：159 行。
  公开符号：`S2LocalAdapter`（5）、`registerScenePackLocalAdapter`（8）、`isRegisteredScenePackLocalAdapter`（9）、`S2CapabilityImplementation`（11）、`S2PluginPackage`（18）、`S2ImplementationDescriptor`（19）、`S2PluginInstallation`（107）。
- `src/services/scene/sceneS2PluginProtocol.ts`：504 行。
  公开符号：`S2_PLUGIN_PROTOCOL_RULES`（8）、`S2PluginProtocolError`（22）、`canonicalS2Json`（59）、`assertS2StructuredValue`（131）、`readS2PluginManifest`（182）、`S2PluginRegistry`（227）、`preflightS2ExecutionGraph`（277）、`readS2Artifact`（320）；其余 7 项见JSON清单。
- `src/services/scene/sceneS2PluginRegistry.ts`：215 行。
  公开符号：`S2_CORE_PLUGIN`（19）、`S2_JSON_CHECK_PLUGIN`（37）、`S2_STRUCTURED_PLUGIN`（50）、`S2_STRUCTURED_VIEW_PLUGIN`（70）、`installSceneInteractionCapabilities`（120）、`s2BuiltinPluginRegistry`（147）、`s2BuiltinPluginInstallation`（149）、`isInstalledS2ModelSession`（151）；其余 7 项见JSON清单。
- `src/services/scene/sceneS2Workflow.ts`：125 行。
  公开符号：`S2_CONTENT_EDITABILITY_RULES`（9）、`S2_COMPOSITE_AGENT_RULES`（13）、`S2_WORKFLOW_AGENT_RULES`（24）、`readS2Workflow`（39）、`s2WorkflowOrder`（98）、`selectS2Execution`（108）、`s2SemanticDocument`（120）、`s2ExecutionLinkKey`（124）。

## 已实现的本地处理、模型实验与资源能力

10 个文件。

- `src/services/scene/sceneS2Human.ts`：34 行。
  公开符号：`S2_HUMAN_PLUGIN`（7）、`isS2Human`（21）、`S2HumanWait`（22）、`s2HumanValue`（27）。
- `src/services/scene/sceneS2ImageResource.ts`：51 行。
  公开符号：`S2ImageResourceInfo`（7）、`S2ImageResourcePreview`（9）、`isS2ImageResource`（10）、`s2ImageResourceId`（12）、`S2ImageResource`（20）、`MAX_LLM_IMAGE_BYTES`（50）。
- `src/services/scene/sceneS2JsonCheck.ts`：17 行。
  公开符号：`executeS2JsonCheck`（5）。
- `src/services/scene/sceneS2Merge.ts`：36 行。
  公开符号：`isS2ExclusiveMerge`（7）、`S2_MERGE_PLUGIN`（10）、`executeS2Merge`（23）。
- `src/services/scene/sceneS2ModelTest.ts`：283 行。
  公开符号：`S2ModelTestLimits`（9）、`S2ModelTestParameterInput`（10）、`S2ModelTestParameters`（11）、`S2ModelTestClosure`（12）、`S2ModelTestRecord`（13）、`S2ModelTestSessionOptions`（21）、`S2ModelTestPreview`（26）、`S2ModelTestSummary`（32）；其余 2 项见JSON清单。
- `src/services/scene/sceneS2ModelTransport.ts`：50 行。
  公开符号：`supportsS2ThinkingControl`（6）、`prepareS2ModelTestProvider`（12）。
- `src/services/scene/sceneS2ProjectNotes.ts`：140 行。
  公开符号：`S2_PROJECT_NOTES_PLUGIN`（5）、`isS2ProjectNotes`（15）、`S2ProjectNoteChoice`（17）、`S2ProjectNoteResourceInfo`（18）、`S2ProjectNoteSourceOptions`（19）、`S2NoteAvailabilityReason`（24）、`S2NoteContentFailureReason`（25）、`S2ProjectNoteSource`（39）；其余 1 项见JSON清单。
- `src/services/scene/sceneS2Simulation.ts`：54 行。
  公开符号：`S2SimulationStep`（5）、`S2SimulationResult`（6）、`S2_SIMULATION_PLUGIN`（16）、`executeS2Simulation`（34）。
- `src/services/scene/sceneS2Structured.ts`：145 行。
  公开符号：`S2Table`（5）、`recordsToS2Table`（12）、`s2TableToRecords`（26）、`S2PointerAccessError`（32）、`S2PointerSyntaxError`（37）、`selectS2Pointer`（40）、`S2StructuredFailureDiagnostic`（53）、`readS2StructuredFailureDiagnostic`（86）；其余 1 项见JSON清单。
- `src/services/scene/sceneS2TextResource.ts`：69 行。
  公开符号：`S2_TEXT_RESOURCE_PLUGIN`（5）、`isS2TextResource`（16）、`S2TextResourceInfo`（18）、`S2TextContentFailureReason`（20）、`S2TextSelectionFailureReason`（21）、`readS2TextSelectionFailure`（23）、`S2TextResource`（31）。

## 搭建与交互 Agent、上下文、记忆、证据和评价

16 个文件。

- `src/services/scene/sceneS2ArtifactAccess.ts`：81 行。
  公开符号：`S2ArtifactSource`（6）、`bindS2ArtifactContext`（10）、`readS2ContextArtifact`（16）、`S2AssessmentArtifactScope`（24）、`createS2AssessmentArtifactScope`（27）、`readS2AssessmentArtifact`（39）、`resolveS2AssessmentOutput`（44）、`readS2ContextTrial`（52）；其余 4 项见JSON清单。
- `src/services/scene/sceneS2Assessment.ts`：262 行。
  公开符号：`S2AssessmentVerdict`（9）、`S2AssessmentEvidence`（10）、`S2AssessmentCheck`（11）、`S2AssessmentReport`（22）、`readS2ComputedAssessment`（31）、`readS2AssessmentRequest`（192）、`S2_ASSESSMENT_RULES`（247）、`formatS2Assessment`（252）。
- `src/services/scene/sceneS2AssistantSnapshot.ts`：96 行。
  公开符号：`snapshotS2AssistantContext`（9）。
- `src/services/scene/sceneS2Business.ts`：217 行。
  公开符号：`readS2Criteria`（85）、`s2Criteria`（93）、`readS2BusinessPackage`（102）、`s2BusinessRuntimeContext`（191）、`s2BusinessProtocolFacts`（204）。
- `src/services/scene/sceneS2BusinessDiagnostics.ts`：164 行。
  公开符号：`S2BusinessDesignIssue`（1）、`s2BusinessDesignIssues`（16）。
- `src/services/scene/sceneS2BusinessRule.ts`：72 行。
  公开符号：`s2BusinessRulePointerSegments`（22）、`readS2BusinessRule`（53）。
- `src/services/scene/sceneS2Context.ts`：246 行。
  公开符号：`S2HistoryMessage`（9）、`S2ContextRecall`（10）、`readS2ContextRecall`（11）、`s2CanvasContext`（59）、`s2CanvasWiringFacts`（79）、`s2CurrentExecutionFacts`（93）、`s2TriggeredExecutionFacts`（110）、`s2HistoryContext`（121）；其余 6 项见JSON清单。
- `src/services/scene/sceneS2Design.ts`：517 行。
  公开符号：`s2DesignBindingIssues`（14）、`s2DesignConnectionIssues`（51）、`S2DesignSources`（130）、`S2_DESIGN_SOURCE_ROLES`（131）、`S2DesignStage`（135）、`S2DesignCall`（136）、`S2DesignJsonError`（138）、`readS2DesignBrief`（156）；其余 6 项见JSON清单。
- `src/services/scene/sceneS2DesignDisclosure.ts`：195 行。
  公开符号：`S2DesignDisclosureReadError`（15）、`S2_DISCLOSURE_SELECT_PROMPT`（23）、`S2_DISCLOSURE_CONTINUE_PROMPT`（26）、`S2_DISCLOSURE_NO_MORE_READS_PROMPT`（27）、`S2DesignDisclosureIndex`（29）、`S2DesignDisclosureContext`（35）、`S2DesignDisclosure`（48）、`createS2DesignDisclosure`（82）。
- `src/services/scene/sceneS2DesignEvidence.ts`：126 行。
  公开符号：`S2EvidenceQuote`（4）、`S2DesignFactClaim`（7）、`S2DesignFactCheck`（11）、`readS2EvidenceQuote`（33）、`readS2DesignFactChecks`（55）。
- `src/services/scene/sceneS2DesignRepair.ts`：58 行。
  公开符号：`S2_DESIGN_REPAIR_ROOTS`（2）、`S2_DESIGN_REPAIR_LIMIT`（3）、`applyS2DesignRepair`（25）、`S2_DESIGN_REPAIR_RULES`（56）。
- `src/services/scene/sceneS2Memory.ts`：109 行。
  公开符号：`S2MemoryRecord`（3）、`S2MemoryFrame`（10）、`S2_MEMORY_LIMITS`（14）、`S2ConversationMemory`（35）、`S2_MEMORY_ACTION_RULES`（99）、`S2_MEMORY_READONLY_RULES`（102）、`S2_MEMORY_RULES`（106）。
- `src/services/scene/sceneS2Output.ts`：16 行。
  公开符号：`recoverS2RedundantObjectClosers`（4）。
- `src/services/scene/sceneS2ProposalReview.ts`：43 行。
  公开符号：`S2ProposalSource`（3）、`S2ProposalReview`（4）、`s2ProposalSources`（9）、`readS2ProposalReview`（20）、`S2_PROPOSAL_REVIEW_RULES`（38）。
- `src/services/scene/sceneS2Trials.ts`：62 行。
  公开符号：`S2TrialValue`（7）、`S2TrialAssessment`（10）、`S2Trial`（12）、`S2TrialComparison`（21）、`readS2TrialComparison`（28）、`formatS2TrialComparison`（52）、`S2_TRIAL_RULES`（59）。
- `src/services/scene/sceneS2Turn.ts`：78 行。
  公开符号：`S2RequirementDecision`（4）、`S2TurnIntent`（11）、`S2_TURN_UNDERSTAND`（26）、`readS2TurnIntent`（37）。

## 画布文档、编辑、显示、输入、连接与诊断

27 个文件。

- `src/services/scene/sceneS2AgentCatalog.ts`：61 行。
  公开符号：`S2AgentParameter`（6）、`S2AgentPort`（17）、`S2AgentComponentDescription`（26）、`S2_AGENT_COMPONENT_RULES`（35）、`projectS2AgentComponents`（46）。
- `src/services/scene/sceneS2BuildContext.ts`：42 行。
  公开符号：`S2_BUILDER_BOUNDARY`（4）、`S2_BUILDER_CANVAS_RULES`（7）、`S2BuilderGuideStage`（15）、`S2BuilderGuide`（16）、`projectS2BuilderGuide`（28）。
- `src/services/scene/sceneS2BuilderCatalog.ts`：109 行。
  公开符号：`S2BuilderCatalogSource`（4）、`s2BuilderDiscoveryCatalog`（12）、`S2BuilderValueShape`（27）、`S2BuilderPort`（32）、`S2BuilderCatalog`（33）、`createS2BuilderCatalog`（83）。
- `src/services/scene/sceneS2Canvas.ts`：645 行。
  公开符号：`S2_LIMITS`（41）、`S2_WORKSPACE_MAX_CHARS`（43）、`readS2Document`（71）、`readS2Definition`（105）、`readS2Scene`（128）、`exportS2Workspace`（142）、`readS2WorkspaceReference`（166）、`importS2WorkspaceWithPack`（169）；其余 8 项见JSON清单。
- `src/services/scene/sceneS2CanvasDelete.ts`：99 行。
  公开符号：`S2CanvasShortcut`（3）、`S2CanvasShortcutEvent`（4）、`S2CanvasShortcutOptions`（12）、`resolveS2CanvasShortcut`（40）、`S2CanvasDeleteSelection`（57）、`deleteS2CanvasSelection`（66）。
- `src/services/scene/sceneS2ConnectionIssues.ts`：205 行。
  公开符号：`S2ConnectionIssue`（8）、`s2ConnectionIssue`（136）。
- `src/services/scene/sceneS2Connections.ts`：124 行。
  公开符号：`S2ConnectionDescription`（11）、`s2ConnectionNodeLabel`（26）、`s2ConnectionPortLabel`（49）、`s2ConnectionFieldLabel`（61）、`s2ConnectionDescriptions`（74）。
- `src/services/scene/sceneS2ControlDrafts.ts`：50 行。
  公开符号：`S2ParameterDraft`（10）、`S2ParameterDrafts`（11）、`S2DraftInputState`（12）、`S2SubmitVia`（13）、`S2HumanDraft`（14）、`S2HumanDrafts`（15）、`S2ConditionState`（16）、`S2ConditionDraft`（17）；其余 5 项见JSON清单。
- `src/services/scene/sceneS2ControlHints.ts`：23 行。
  公开符号：`s2FieldRequirement`（4）。
- `src/services/scene/sceneS2ControlIssue.ts`：15 行。
  公开符号：`S2ControlPath`（2）、`S2ControlIssue`（3）、`s2ControlTarget`（5）、`throwS2ControlIssue`（6）、`s2ControlIssue`（11）。
- `src/services/scene/sceneS2Controls.ts`：161 行。
  公开符号：`S2_CONTROL_KINDS`（7）、`readS2Field`（18）、`validateS2FieldText`（98）、`s2DefaultFieldText`（107）、`S2ControlDraft`（111）、`s2ControlDraft`（112）、`s2SubmitControlDraft`（126）、`S2FieldSubmission`（151）；其余 2 项见JSON清单。
- `src/services/scene/sceneS2DataViews.ts`：83 行。
  公开符号：`readS2TableColumns`（12）、`readS2ChartView`（23）、`validateS2TableRows`（28）、`S2TableCellDraft`（43）、`S2TableDraft`（44）、`s2TableDraft`（45）、`s2TableDraftValue`（51）、`s2ChartPoints`（66）；其余 1 项见JSON清单。
- `src/services/scene/sceneS2Events.ts`：70 行。
  公开符号：`S2FieldControlState`（2）、`S2ArtifactViewSelection`（3）、`S2JsonTreeSelection`（4）、`S2ParameterControlState`（5）、`S2CanvasAction`（6）、`S2InteractionData`（7）、`S2InteractionEvent`（22）、`S2InteractionLog`（30）。
- `src/services/scene/sceneS2FieldChoices.ts`：87 行。
  公开符号：`S2FieldChoicesReport`（9）、`listS2ValueFields`（44）、`prepareS2FieldChoices`（59）、`readS2FieldChoices`（77）、`applyS2FieldChoice`（80）。
- `src/services/scene/sceneS2Layout.ts`：83 行。
  公开符号：`s2AllNodes`（5）、`readS2Groups`（6）、`pruneS2Groups`（18）、`mutateS2Batch`（22）、`s2GroupBounds`（78）。
- `src/services/scene/sceneS2Materials.ts`：85 行。
  公开符号：`s2MaterialTypeLabel`（9）、`s2MaterialInput`（14）、`planS2MaterialInput`（53）。
- `src/services/scene/sceneS2ModelBridge.ts`：27 行。
  公开符号：`S2_MODEL_SESSION_BRIDGE`（7）、`isS2ModelSessionCapability`（18）、`isS2ModelSessionImplementation`（24）。
- `src/services/scene/sceneS2ParameterForm.ts`：48 行。
  公开符号：`readS2ParameterForm`（8）、`submitS2ParameterForm`（29）、`s2ParameterFormDraft`（41）。
- `src/services/scene/sceneS2PluginHelp.ts`：157 行。
  公开符号：`s2PluginHelp`（127）、`s2PluginHelpMatches`（150）。
- `src/services/scene/sceneS2Presentation.ts`：109 行。
  公开符号：`s2NodeTitle`（47）、`s2NodeDescription`（50）、`s2PortLabel`（53）、`s2StatusLabel`（57）、`s2IsHumanConfirmationOutput`（64）、`s2HumanConfirmationOutcome`（68）、`readS2NodePresentation`（74）。
- `src/services/scene/sceneS2PublicAuthoring.ts`：412 行。
  公开符号：`S2PublicCanvas`（10）、`S2PublicFieldRules`（19）、`S2PublicParameter`（28）、`S2PublicComponentDescription`（38）、`S2PublicComponentCatalog`（42）、`S2PublicAuthoringError`（43）、`findS2PublicComponent`（187）、`publicS2Catalog`（204）；其余 3 项见JSON清单。
- `src/services/scene/sceneS2PublicDesign.ts`：160 行。
  公开符号：`S2_PUBLIC_DESIGN_SELECT`（10）、`S2_PUBLIC_DESIGN_COMPOSE`（11）、`S2PublicDesignOptions`（19）、`buildS2PublicDesign`（46）。
- `src/services/scene/sceneS2PublicSession.ts`：41 行。
  公开符号：`prepareS2PublicDefinition`（8）、`appendS2PublicComponent`（24）。
- `src/services/scene/sceneS2ReadOnly.ts`：30 行。
  公开符号：`assertS2ReadOnlyContent`（8）。
- `src/services/scene/sceneS2ResourceUi.ts`：47 行。
  公开符号：`S2TextResourceUi`（4）、`S2ImageResourceUi`（5）、`s2ResourceUiDocument`（10）、`s2ResourceUi`（26）。
- `src/services/scene/sceneS2RuntimeIssues.ts`：248 行。
  公开符号：`S2RuntimeIssue`（10）、`s2RuntimeIssue`（24）、`s2TextFileSelectionIssue`（208）、`s2WorkflowPreflightIssue`（226）。
- `src/services/scene/sceneS2SimpleValueForm.ts`：200 行。
  公开符号：`S2SimpleScalarKind`（5）、`S2SimpleScalarDraft`（6）、`S2SimpleListDraft`（7）、`S2SimpleListItem`（11）、`S2SimpleValueRow`（14）、`S2SimpleValueDraft`（17）、`S2_SIMPLE_VALUE_MAX_FIELDS`（22）、`S2_SIMPLE_VALUE_MAX_RECORDS`（23）；其余 8 项见JSON清单。

## 组合节点、蓝图库、版本比较与显式迁移

7 个文件。

- `src/services/scene/sceneS2BlueprintDesign.ts`：117 行。
  公开符号：`S2_BLUEPRINT_DESIGN_RULES`（15）、`createS2BlueprintDesign`（23）。
- `src/services/scene/sceneS2Composite.ts`：187 行。
  公开符号：`S2_COMPOSITE_MAX_BYTES`（7）、`S2_COMPOSITE_MAX_EXPANDED_CHARS`（9）、`snapshotS2CompositeData`（53）、`readS2CompositeBlueprint`（86）、`exportS2CompositeBlueprint`（141）、`importS2CompositeBlueprint`（144）、`expandS2Composite`（150）、`s2CompositeSignature`（184）。
- `src/services/scene/sceneS2CompositeCanvas.ts`：167 行。
  公开符号：`s2CanvasCompositeBlueprint`（23）、`readS2CanvasComposites`（60）、`s2CompositePath`（104）、`s2CompositeSubset`（115）、`wrapS2CanvasComposite`（120）、`unwrapS2CanvasComposite`（130）、`moveS2CanvasComposite`（138）、`placeS2NewStepsInComposite`（150）；其余 2 项见JSON清单。
- `src/services/scene/sceneS2CompositeComparison.ts`：103 行。
  公开符号：`compareS2CompositeDesigns`（21）、`S2CompositeComparison`（102）。
- `src/services/scene/sceneS2CompositeInstance.ts`：106 行。
  公开符号：`inspectS2CompositeInstance`（18）、`S2CompositeInstanceInspection`（105）。
- `src/services/scene/sceneS2CompositeLibrary.ts`：97 行。
  公开符号：`S2_BLUEPRINT_AGENT_RULES`（10）、`readS2CompositeDesign`（14）、`createS2CompositeDesign`（28）、`s2CompositeDesignSignature`（38）、`readS2CompositeLibrary`（41）、`addS2CompositeDesign`（52）、`importS2CompositeDesign`（58）、`exportS2CompositeDesign`（62）；其余 3 项见JSON清单。
- `src/services/scene/sceneS2CompositeMigration.ts`：443 行。
  公开符号：`S2CompositeCopyChoice`（21）、`previewS2CompositeMigration`（43）、`S2CompositeMigrationPreview`（131）、`isS2CompositeMigrationPreviewCurrent`（134）、`readS2CompositeMigrationDetail`（144）、`prepareS2CompositeCopy`（158）、`S2CompositeCopyCandidate`（214）、`isS2CompositeCopyCurrent`（215）；其余 12 项见JSON清单。

## 生产 React 组件与画布样式

17 个文件。

- `src/components/scene/S2ArtifactChart.tsx`：33 行。
  公开符号：`S2ArtifactChart`（11）。
- `src/components/scene/S2ArtifactView.tsx`：73 行。
  公开符号：`S2JsonTreeBranch`（12）、`S2ArtifactView`（20）。
- `src/components/scene/S2ChartPreview.tsx`：23 行。
  公开符号：`S2ChartPreview`（5）。
- `src/components/scene/S2ConditionEditor.tsx`：134 行。
  公开符号：`S2ConditionFields`（6）、`S2ConditionEditor`（15）。
- `src/components/scene/S2ContentNodeView.tsx`：61 行。
  公开符号：`S2ContentNodeField`（8）、`S2ContentNodeData`（17）、`S2ContentNodeView`（23）。
- `src/components/scene/S2FieldEditor.tsx`：166 行。
  公开符号：`S2FieldDraft`（11）、`S2FieldDrafts`（12）、`S2ControlInput`（14）、`S2FieldEditor`（69）。
- `src/components/scene/S2FieldPreview.tsx`：25 行。
  公开符号：`S2FieldPreview`（9）。
- `src/components/scene/S2HumanInput.tsx`：122 行。
  公开符号：`S2HumanInput`（10）。
- `src/components/scene/S2ImageMaterials.tsx`：108 行。
  公开符号：`S2ImageMaterialsProps`（7）、`S2ImageMaterials`（21）。
- `src/components/scene/S2JsonParameter.tsx`：134 行。
  公开符号：`S2JsonParameter`（13）。
- `src/components/scene/S2RunSummary.tsx`：41 行。
  公开符号：`S2RunSummary`（7）。
- `src/components/scene/S2SimpleValueInput.tsx`：129 行。
  公开符号：`focusS2SimpleValueIssue`（5）、`S2SimpleValueInput`（20）。
- `src/components/scene/S2TextMaterialInput.tsx`：73 行。
  公开符号：`S2TextMaterialInputProps`（6）、`S2TextMaterialInput`（19）。
- `src/components/scene/S2WorkflowNodeView.tsx`：56 行。
  公开符号：`S2WorkflowNodeData`（11）、`s2WorkflowVisibleInputs`（12）、`S2WorkflowNodeView`（16）。
- `src/components/scene/sceneS2Canvas.css`：210 行。
- `src/components/scene/SceneS2CanvasTrial.tsx`：2558 行。
  公开符号：`SceneS2CanvasTrial`（137）。
- `src/components/scene/SceneS2PackBoundary.tsx`：35 行。
  公开符号：`SceneS2PackBoundary`（10）。

## 离线检查脚本；名称不表示已经执行或通过

147 个文件。

- `scripts/check-scene-s2-adapter-conformance.ts`：30 行。
- `scripts/check-scene-s2-advanced.ts`：114 行。
- `scripts/check-scene-s2-agent-context-size.ts`：184 行。
- `scripts/check-scene-s2-agent-validation.ts`：123 行。
- `scripts/check-scene-s2-artifact-assessment.ts`：166 行。
- `scripts/check-scene-s2-artifact-context.ts`：135 行。
- `scripts/check-scene-s2-artifact-interaction.ts`：79 行。
- `scripts/check-scene-s2-assessment.ts`：150 行。
- `scripts/check-scene-s2-blueprint-design.ts`：248 行。
- `scripts/check-scene-s2-browser-isolation.ts`：95 行。
- `scripts/check-scene-s2-browser-protocol.ts`：602 行。
- `scripts/check-scene-s2-build-context.ts`：66 行。
- `scripts/check-scene-s2-builder-catalog.ts`：94 行。
- `scripts/check-scene-s2-builder-context-integration.ts`：63 行。
- `scripts/check-scene-s2-builtin-installation.tsx`：155 行。
- `scripts/check-scene-s2-business-evidence.ts`：82 行。
- `scripts/check-scene-s2-business-interaction-validation.ts`：258 行。
- `scripts/check-scene-s2-business-interaction.ts`：143 行。
- `scripts/check-scene-s2-business-validation.ts`：264 行。
- `scripts/check-scene-s2-business.ts`：330 行。
- `scripts/check-scene-s2-canvas-delete.ts`：123 行。
- `scripts/check-scene-s2-canvas-live-bridge.ts`：106 行。
- `scripts/check-scene-s2-canvas-live-config.ts`：129 行。
- `scripts/check-scene-s2-canvas.ts`：133 行。
- `scripts/check-scene-s2-compose-structure.tsx`：139 行。
- `scripts/check-scene-s2-compose.ts`：80 行。
- `scripts/check-scene-s2-composite-canvas.tsx`：125 行。
- `scripts/check-scene-s2-composite-comparison.tsx`：116 行。
- `scripts/check-scene-s2-composite-copy.tsx`：200 行。
- `scripts/check-scene-s2-composite-instance.tsx`：160 行。
- `scripts/check-scene-s2-composite-library.tsx`：113 行。
- `scripts/check-scene-s2-composite-migration.tsx`：181 行。
- `scripts/check-scene-s2-composite-nesting.tsx`：161 行。
- `scripts/check-scene-s2-composite.ts`：184 行。
- `scripts/check-scene-s2-condition-forms.tsx`：327 行。
- `scripts/check-scene-s2-condition-issues.ts`：183 行。
- `scripts/check-scene-s2-condition-recovery-ui.tsx`：165 行。
- `scripts/check-scene-s2-condition-view-lifecycle.tsx`：166 行。
- `scripts/check-scene-s2-conditions.ts`：103 行。
- `scripts/check-scene-s2-connection-issues.ts`：181 行。
- `scripts/check-scene-s2-connection-recovery-ui.tsx`：216 行。
- `scripts/check-scene-s2-connection-ui.tsx`：165 行。
- `scripts/check-scene-s2-connections.ts`：136 行。
- `scripts/check-scene-s2-content-blocks.ts`：85 行。
- `scripts/check-scene-s2-content-name-ui.ts`：102 行。
- `scripts/check-scene-s2-context.ts`：457 行。
- `scripts/check-scene-s2-control-lifecycle.tsx`：156 行。
- `scripts/check-scene-s2-controls.tsx`：236 行。
- `scripts/check-scene-s2-data-views.tsx`：161 行。
- `scripts/check-scene-s2-design-consistency.ts`：185 行。
- `scripts/check-scene-s2-design-disclosure.ts`：191 行。
- `scripts/check-scene-s2-design-repair.ts`：422 行。
- `scripts/check-scene-s2-design.ts`：365 行。
- `scripts/check-scene-s2-discovery-scope.ts`：111 行。
- `scripts/check-scene-s2-editable-issues.tsx`：160 行。
- `scripts/check-scene-s2-evaluation-intent.ts`：175 行。
- `scripts/check-scene-s2-events.ts`：186 行。
- `scripts/check-scene-s2-experiment-ui.tsx`：166 行。
- `scripts/check-scene-s2-experiment.ts`：158 行。
- `scripts/check-scene-s2-field-choices.tsx`：267 行。
- `scripts/check-scene-s2-field-integrity.ts`：133 行。
- `scripts/check-scene-s2-five-blocks.tsx`：191 行。
- `scripts/check-scene-s2-host-result-live-safety.ts`：184 行。
- `scripts/check-scene-s2-host-result-validation.ts`：88 行。
- `scripts/check-scene-s2-human-recovery.tsx`：152 行。
- `scripts/check-scene-s2-human.tsx`：189 行。
- `scripts/check-scene-s2-image-materials.tsx`：130 行。
- `scripts/check-scene-s2-images.ts`：147 行。
- `scripts/check-scene-s2-inline-content.tsx`：158 行。
- `scripts/check-scene-s2-installation.ts`：161 行。
- `scripts/check-scene-s2-iteration.ts`：256 行。
- `scripts/check-scene-s2-layout-events.ts`：140 行。
- `scripts/check-scene-s2-light-design.ts`：124 行。
- `scripts/check-scene-s2-live-safety.ts`：597 行。
- `scripts/check-scene-s2-manual-prompt.tsx`：120 行。
- `scripts/check-scene-s2-manual-reuse.tsx`：110 行。
- `scripts/check-scene-s2-materials.ts`：165 行。
- `scripts/check-scene-s2-merge.tsx`：124 行。
- `scripts/check-scene-s2-model-boundary.ts`：140 行。
- `scripts/check-scene-s2-model-bridge.ts`：146 行。
- `scripts/check-scene-s2-model-lifecycle.ts`：151 行。
- `scripts/check-scene-s2-model-parameters-ui.tsx`：139 行。
- `scripts/check-scene-s2-model-parameters.ts`：118 行。
- `scripts/check-scene-s2-model-recovery.tsx`：139 行。
- `scripts/check-scene-s2-model-test.ts`：268 行。
- `scripts/check-scene-s2-model-ui.ts`：104 行。
- `scripts/check-scene-s2-natural-assistant.ts`：121 行。
- `scripts/check-scene-s2-optional-assistant.ts`：209 行。
- `scripts/check-scene-s2-output-apply-ui.tsx`：196 行。
- `scripts/check-scene-s2-output-apply.ts`：253 行。
- `scripts/check-scene-s2-output-index.ts`：68 行。
- `scripts/check-scene-s2-output-reconnect-ui.tsx`：167 行。
- `scripts/check-scene-s2-output-reconnect.ts`：184 行。
- `scripts/check-scene-s2-pack-ui-policy.tsx`：228 行。
- `scripts/check-scene-s2-pack-views-browser.ts`：106 行。
- `scripts/check-scene-s2-parameter-forms.tsx`：289 行。
- `scripts/check-scene-s2-plugin-help.tsx`：137 行。
- `scripts/check-scene-s2-plugin-host.ts`：116 行。
- `scripts/check-scene-s2-plugins.ts`：163 行。
- `scripts/check-scene-s2-presentation.tsx`：129 行。
- `scripts/check-scene-s2-progressive-disclosure.ts`：313 行。
- `scripts/check-scene-s2-project-notes.ts`：215 行。
- `scripts/check-scene-s2-prompt-controls.tsx`：99 行。
- `scripts/check-scene-s2-prompt-inline-browser.ts`：425 行。
- `scripts/check-scene-s2-prompt-recovery.tsx`：168 行。
- `scripts/check-scene-s2-proposal-review.ts`：211 行。
- `scripts/check-scene-s2-public-authoring.ts`：199 行。
- `scripts/check-scene-s2-public-builder.ts`：302 行。
- `scripts/check-scene-s2-public-interface-ui.tsx`：162 行。
- `scripts/check-scene-s2-public-parameter-rules.ts`：140 行。
- `scripts/check-scene-s2-readonly-design.ts`：129 行。
- `scripts/check-scene-s2-readonly-host.ts`：133 行。
- `scripts/check-scene-s2-readonly-prompt.ts`：69 行。
- `scripts/check-scene-s2-readonly-ui.tsx`：222 行。
- `scripts/check-scene-s2-readonly.ts`：119 行。
- `scripts/check-scene-s2-record-forms.tsx`：587 行。
- `scripts/check-scene-s2-registration-integrity.ts`：101 行。
- `scripts/check-scene-s2-replacement.ts`：98 行。
- `scripts/check-scene-s2-resource-content-recovery.tsx`：176 行。
- `scripts/check-scene-s2-resource-recovery.tsx`：183 行。
- `scripts/check-scene-s2-response-form-contract.ts`：87 行。
- `scripts/check-scene-s2-response-form.tsx`：223 行。
- `scripts/check-scene-s2-result-reading.tsx`：90 行。
- `scripts/check-scene-s2-review-task.tsx`：180 行。
- `scripts/check-scene-s2-rich-controls.ts`：38 行。
- `scripts/check-scene-s2-run-summary.tsx`：78 行。
- `scripts/check-scene-s2-runtime-issues.ts`：146 行。
- `scripts/check-scene-s2-runtime-recovery-ui.tsx`：161 行。
- `scripts/check-scene-s2-sidebar.tsx`：111 行。
- `scripts/check-scene-s2-simple-value-forms.tsx`：171 行。
- `scripts/check-scene-s2-simulation.tsx`：113 行。
- `scripts/check-scene-s2-table-recovery.tsx`：152 行。
- `scripts/check-scene-s2-targeted-validation.ts`：55 行。
- `scripts/check-scene-s2-task-replay.ts`：117 行。
- `scripts/check-scene-s2-template-layout.tsx`：175 行。
- `scripts/check-scene-s2-text-material-input.tsx`：112 行。
- `scripts/check-scene-s2-text-resource.ts`：191 行。
- `scripts/check-scene-s2-text-template.ts`：259 行。
- `scripts/check-scene-s2-transform-issues.ts`：186 行。
- `scripts/check-scene-s2-transform-recovery-ui.tsx`：174 行。
- `scripts/check-scene-s2-trials.ts`：103 行。
- `scripts/check-scene-s2-ui-agent-validation.ts`：101 行。
- `scripts/check-scene-s2-ui-evidence.ts`：153 行。
- `scripts/check-scene-s2-ui.ts`：631 行。
- `scripts/check-scene-s2-user-action-boundary.ts`：104 行。
- `scripts/check-scene-s2-user-action-model.ts`：147 行。
- `scripts/check-scene-s2-workflow.tsx`：145 行。

## 合成验证驱动、运行器支撑与测试 harness

13 个文件。

- `scripts/scene-s2-adapter-conformance.ts`：210 行。
  公开符号：`checkS2LocalAdapterConformance`（30）。
- `scripts/scene-s2-adapter-fixtures.ts`：31 行。
  公开符号：`s2AdapterRecords`（5）、`s2AdapterSimulation`（8）、`s2LocalAdapterSamples`（11）、`S2LocalAdapterFixture`（27）。
- `scripts/scene-s2-agent-validation.ts`：130 行。
  公开符号：`S2_VALIDATION_REQUEST`（11）、`S2_VALIDATION_QUERIES`（13）、`S2_VALIDATION_CHECKS`（20）、`S2ValidationStop`（22）、`S2ValidationStep`（25）、`S2ValidationReport`（26）、`readS2ValidationJudge`（29）、`runS2AgentValidation`（44）。
- `scripts/scene-s2-business-interaction-validation.ts`：315 行。
  公开符号：`S2_BUSINESS_INTERACTION_CHECKS`（16）、`S2InteractionEvidence`（20）、`S2_INTERACTION_EVIDENCE_LIMITS`（21）、`compileS2InteractionEvidence`（32）、`runS2BusinessInteractionValidation`（117）。
- `scripts/scene-s2-business-validation.ts`：216 行。
  公开符号：`S2_BUSINESS_VALIDATION_CHECKS`（13）、`S2_BUSINESS_VALIDATION_CASE`（15）、`s2BusinessCaseReferenceSource`（50）、`s2BusinessCaseArtifactFacts`（65）、`runS2BusinessValidation`（101）。
- `scripts/scene-s2-exact-replay.ts`：19 行。
  公开符号：`createS2ExactReplay`（4）。
- `scripts/scene-s2-host-result-validation.ts`：144 行。
  公开符号：`S2HostResultSource`（16）、`prepareS2HostResultSource`（25）、`runS2HostResultValidation`（83）。
- `scripts/scene-s2-targeted-validation.ts`：114 行。
  公开符号：`S2_TARGETED_CHECKS`（11）、`readS2TargetedJudge`（12）、`runS2TargetedValidation`（24）。
- `scripts/scene-s2-task-cases.ts`：40 行。
  公开符号：`S2_TASK_CASES`（18）、`S2TaskCaseId`（35）、`s2TaskCase`（36）。
- `scripts/scene-s2-task-replay.ts`：98 行。
  公开符号：`prepareS2TaskReplay`（12）。
- `scripts/scene-s2-ui-agent-validation.ts`：263 行。
  公开符号：`S2UiValidationCase`（19）、`s2ValidationLearnerField`（31）、`runS2UiAgentValidation`（44）。
- `scripts/scene-s2-ui-evidence.ts`：161 行。
  公开符号：`S2UiReviewStep`（8）、`S2UiEvidence`（15）、`S2UiReviewCheck`（16）、`S2_UI_EVIDENCE_LIMITS`（17）、`S2UiEvidenceError`（19）、`S2UiEvidenceInput`（45）、`buildS2UiReviewEvidence`（53）、`readS2UiEvidenceJudge`（144）；其余 1 项见JSON清单。
- `scripts/scene-s2-ui-harness.ts`：362 行。
  公开符号：`harness`（51）。

## 需显式授权的真实模型验收设施，不是产品插件服务

6 个文件。

- `scripts/run-scene-s2-canvas-live.ts`：79 行。
- `scripts/run-scene-s2-host-result-live.ts`：169 行。
- `scripts/run-scene-s2-live.ts`：516 行。
- `scripts/run-scene-s2-simple-experiment-live.ts`：172 行。
- `scripts/s2-canvas-live-bridge.ts`：161 行。
  公开符号：`S2_LIVE_ORIGIN`（9）、`S2_LIVE_PROMPT`（10）、`S2_LIVE_INPUT`（11）、`S2_LIVE_TOKEN_HEADER`（12）、`S2LiveDispatch`（13）、`S2LiveBridgeState`（14）、`S2CanvasLiveBridgeOptions`（15）、`createS2CanvasLiveBridge`（44）。
- `scripts/vite-s2-canvas-live.ts`：73 行。
  公开符号：`s2LiveClientRequestAllowed`（25）、`s2CanvasLiveConfig`（33）。

## 隔离浏览器、预制示例、合成传输与测试工作区

48 个文件。

- `scripts/fixtures/s2-arithmetic-pack.ts`：68 行。
  公开符号：`activate`（8）、`arithmeticConfig`（55）。
- `scripts/fixtures/s2-browser-acceptance.css`：8 行。
- `scripts/fixtures/s2-browser-acceptance.html`：6 行。
- `scripts/fixtures/s2-browser-acceptance.tsx`：215 行。
- `scripts/fixtures/s2-browser-definition.ts`：364 行。
  公开符号：`browserRequest`（6）、`browserInputText`（10）、`browserNotesText`（11）、`browserResourceText`（16）、`browserResourceState`（17）、`browserResourceSource`（18）、`browserResourceRequest`（24）、`browserResourceDefinition`（44）；其余 26 项见JSON清单。
- `scripts/fixtures/s2-browser-json.ts`：9 行。
  公开符号：`parseJsonLenient`（2）。
- `scripts/fixtures/s2-browser-model-transport.ts`：42 行。
  公开符号：`prepareS2ModelTestProvider`（12）。
- `scripts/fixtures/s2-browser-model.ts`：162 行。
  公开符号：`BrowserFixtureMode`（8）、`BrowserFixtureScenario`（9）、`BrowserFixtureCall`（11）、`browserFixtureState`（18）、`subscribeBrowserFixture`（28）、`notifyBrowserFixture`（29）、`setBrowserFixtureMode`（30）、`setBrowserFixtureScenario`（34）；其余 2 项见JSON清单。
- `scripts/fixtures/s2-browser-settings.ts`：13 行。
  公开符号：`ensureLlmSettingsLoaded`（9）、`readLlmSettingsForUse`（10）、`loadLlmSettings`（11）、`getDefaultLlmSettings`（12）。
- `scripts/fixtures/s2-browser-store.ts`：26 行。
  公开符号：`loadManifest`（12）、`loadScene`（16）、`saveScene`（20）。
- `scripts/fixtures/s2-business-model.ts`：24 行。
  公开符号：`syntheticS2Business`（6）。
- `scripts/fixtures/s2-canvas-preview.html`：5 行。
- `scripts/fixtures/s2-canvas-preview.tsx`：24 行。
- `scripts/fixtures/s2-canvas-ui-actions.ts`：35 行。
  公开符号：`submitS2InlineContent`（8）、`addS2PackCapability`（19）、`addS2PublicComponent`（30）。
- `scripts/fixtures/s2-condition-recovery-workspace.json`：49 行。
- `scripts/fixtures/s2-conditional-workflow.html`：5 行。
- `scripts/fixtures/s2-conditional-workflow.tsx`：29 行。
- `scripts/fixtures/s2-design-context.ts`：25 行。
  公开符号：`withS2DesignContext`（2）。
- `scripts/fixtures/s2-design-model.ts`：43 行。
  公开符号：`s2DesignFixtureResponse`（7）、`s2TurnFixtureAdapter`（25）。
- `scripts/fixtures/s2-experiment.ts`：81 行。
  公开符号：`experimentRequest`（6）、`experimentImageRequest`（9）、`experimentMaterialRequest`（11）、`SYNTHETIC_EXPERIMENT_PNG`（13）、`SYNTHETIC_EXPERIMENT_TEXT`（14）、`experimentDefinition`（68）、`experimentImageDefinition`（69）、`experimentMaterialDefinition`（71）。
- `scripts/fixtures/s2-generic-canvas-ui.ts`：25 行。
  公开符号：`useLegacyS2Authoring`（4）、`useGenericS2CanvasUi`（19）。
- `scripts/fixtures/s2-human-form-workspace.json`：49 行。
- `scripts/fixtures/s2-human-recovery-workspace.json`：57 行。
- `scripts/fixtures/s2-human-workflow.html`：5 行。
- `scripts/fixtures/s2-human-workflow.tsx`：26 行。
- `scripts/fixtures/s2-live-canvas.tsx`：55 行。
- `scripts/fixtures/s2-live-model-transport.ts`：88 行。
  公开符号：`prepareS2ModelTestProvider`（59）。
- `scripts/fixtures/s2-material-browser.html`：7 行。
- `scripts/fixtures/s2-material-browser.tsx`：114 行。
- `scripts/fixtures/s2-materials-workspace.json`：26 行。
- `scripts/fixtures/s2-merge-workflow.html`：5 行。
- `scripts/fixtures/s2-merge-workflow.tsx`：28 行。
- `scripts/fixtures/s2-model-recovery-workspace.json`：48 行。
- `scripts/fixtures/s2-output-reconnect-workspace.json`：347 行。
- `scripts/fixtures/s2-pack-client.html`：16 行。
- `scripts/fixtures/s2-pack-client.tsx`：91 行。
- `scripts/fixtures/s2-parameter-forms-workspace.json`：65 行。
- `scripts/fixtures/s2-prompt-inline-browser.html`：5 行。
- `scripts/fixtures/s2-prompt-inline-browser.tsx`：136 行。
- `scripts/fixtures/s2-review-task.ts`：96 行。
  公开符号：`reviewTaskText`（7）、`reviewTaskState`（8）、`reviewTaskSource`（9）、`reviewTaskRequest`（15）、`reviewTaskDefinition`（45）、`manualPromptRequest`（63）、`manualPromptTexts`（67）、`manualPromptExpected`（68）；其余 1 项见JSON清单。
- `scripts/fixtures/s2-rich-controls-workspace.json`：57 行。
- `scripts/fixtures/s2-run-feedback-workspace.json`：28 行。
- `scripts/fixtures/s2-runtime-recovery-workspace.json`：64 行。
- `scripts/fixtures/s2-table-recovery-workspace.json`：56 行。
- `scripts/fixtures/s2-transform-recovery-workspace.json`：49 行。
- `scripts/fixtures/s2-workflow-simulation.html`：5 行。
- `scripts/fixtures/s2-workflow-simulation.tsx`：30 行。
- `scripts/vite-s2-browser.config.ts`：142 行。
  公开符号：`S2_BROWSER_ENTRY`（9）、`S2_BROWSER_PORT`（10）、`S2_BROWSER_BOUNDARIES`（11）、`s2BrowserBoundaryAlias`（55）、`s2BrowserAllowedModule`（61）、`s2BrowserAllowedRequest`（81）、`createS2BrowserIsolationPlugin`（92）、`s2BrowserIsolationConfig`（125）。

## 当前计划、交接说明或历史文档

2 个文件。

- `docs/s2-development-handoff.md`：271 行。
- `docs/s2-plugin-workbench-plan.md`：1628 行。

## 历史界面证据，不代表当前全部功能已通过

87 个文件。

- `docs/s2_batch58_list_form.png`：110851 字节。
- `docs/s2_batch59_named_lists.png`：117740 字节。
- `docs/s2_batch60_issue_focus.png`：110629 字节。
- `docs/s2_batch61_declared_issue.png`：109043 字节。
- `docs/s2_batch61_declared_number_issue.png`：108166 字节。
- `docs/s2_batch61_declared_result.png`：41833 字节。
- `docs/s2_batch62_field_issue.png`：103641 字节。
- `docs/s2_batch62_human_issue.png`：106134 字节。
- `docs/s2_batch62_human_result.png`：40185 字节。
- `docs/s2_batch63_requirements.png`：101103 字节。
- `docs/s2_batch64_mixed_list.png`：108220 字节。
- `docs/s2_batch64_mixed_result.png`：43531 字节。
- `docs/s2_batch65_original_template_final.png`：111574 字节。
- `docs/s2_batch65_sources_final.png`：122032 字节。
- `docs/s2_batch66_legacy_fresh_wait.png`：114937 字节。
- `docs/s2_batch66_manual_prompt_result.png`：45237 字节。
- `docs/s2_batch67_condition_summary.png`：119940 字节。
- `docs/s2_batch67_confirmation_choice.png`：118747 字节。
- `docs/s2_batch67_confirmation_fields_final.png`：122975 字节。
- `docs/s2-batch24-browser-proof.jpg`：147643 字节。
- `docs/s2-batch26-composite-proof.jpg`：113569 字节。
- `docs/s2-batch27-nested-canvas-proof.jpg`：117247 字节。
- `docs/s2-batch27-nested-output-proof.jpg`：113552 字节。
- `docs/s2-batch27-refreshed-canvas-proof.jpg`：117242 字节。
- `docs/s2-batch27-refreshed-output-proof.jpg`：113546 字节。
- `docs/s2-batch28-blueprint-library-proof.jpg`：141193 字节。
- `docs/s2-batch28-blueprint-result-proof.jpg`：145631 字节。
- `docs/s2-batch30-version-comparison-proof.jpg`：129660 字节。
- `docs/s2-batch31-instance-drift-proof.jpg`：120436 字节。
- `docs/s2-batch32-carry-preview-proof.jpg`：124360 字节。
- `docs/s2-batch33-copy-preview-proof.jpg`：122567 字节。
- `docs/s2-batch33-independent-copy-proof.jpg`：137174 字节。
- `docs/s2-batch34-plugin-context-proof.jpg`：117280 字节。
- `docs/s2-batch34-plugin-example-proof.jpg`：115180 字节。
- `docs/s2-batch35-prompt-form-proof.jpg`：112548 字节。
- `docs/s2-batch35-prompt-result-proof.jpg`：108503 字节。
- `docs/s2-batch36-field-choice-proof.jpg`：142352 字节。
- `docs/s2-batch36-field-form-proof.jpg`：145987 字节。
- `docs/s2-batch36-field-result-proof.jpg`：134993 字节。
- `docs/s2-batch37-condition-form-proof.jpg`：113077 字节。
- `docs/s2-batch37-final-condition-proof.jpg`：115414 字节。
- `docs/s2-batch37-native-result-proof.jpg`：120879 字节。
- `docs/s2-batch38-connection-proof.jpg`：110220 字节。
- `docs/s2-batch38-result-proof.jpg`：115588 字节。
- `docs/s2-batch39-cycle-proof.jpg`：122824 字节。
- `docs/s2-batch39-recovery-proof.jpg`：122645 字节。
- `docs/s2-batch40-output-preview-proof.jpg`：110801 字节。
- `docs/s2-batch41-output-apply-proof.jpg`：117489 字节。
- `docs/s2-batch42-runtime-recovery-proof.jpg`：120505 字节。
- `docs/s2-batch42-runtime-recovery-success.jpg`：110351 字节。
- `docs/s2-batch43-condition-diagnostic-proof.jpg`：119574 字节。
- `docs/s2-batch43-condition-recovery-proof.jpg`：107182 字节。
- `docs/s2-batch44-extraction-diagnostic-proof.jpg`：105096 字节。
- `docs/s2-batch44-json-diagnostic-proof.jpg`：97916 字节。
- `docs/s2-batch44-transform-recovery-proof.jpg`：78482 字节。
- `docs/s2-batch45-table-diagnostic-proof.jpg`：125015 字节。
- `docs/s2-batch45-table-recovery-proof.jpg`：146416 字节。
- `docs/s2-batch46-human-recovery-proof.jpg`：117658 字节。
- `docs/s2-batch46-human-waits-proof.jpg`：112205 字节。
- `docs/s2-batch47-model-budget-proof.jpg`：127789 字节。
- `docs/s2-batch47-model-closed-proof.jpg`：160790 字节。
- `docs/s2-batch48-note-change-proof.jpg`：140766 字节。
- `docs/s2-batch48-resource-recovery-proof.jpg`：135808 字节。
- `docs/s2-batch49-content-recovery-proof.jpg`：134867 字节。
- `docs/s2-batch49-file-encoding-proof.jpg`：144576 字节。
- `docs/s2-batch49-note-empty-proof.jpg`：137404 字节。
- `docs/s2-batch50-record-form-proof.png`：101958 字节。
- `docs/s2-batch50-record-result-proof.png`：118512 字节。
- `docs/s2-batch51-group-form-proof.png`：104735 字节。
- `docs/s2-batch51-group-result-proof.png`：118238 字节。
- `docs/s2-batch52-template-form-proof.png`：116155 字节。
- `docs/s2-batch53-free-result-proof.png`：127968 字节。
- `docs/s2-batch53-review-branches-proof.png`：127871 字节。
- `docs/s2-batch53-review-proof.png`：128307 字节。
- `docs/s2-batch53-review-text-proof.png`：127791 字节。
- `docs/s2-batch54-manual-table-proof.png`：123759 字节。
- `docs/s2-batch54-node-spacing-proof.png`：116034 字节。
- `docs/s2-batch55-full-result-proof.png`：77568 字节。
- `docs/s2-batch55-last-row-proof.png`：78576 字节。
- `docs/s2-batch56-common-controls-proof.png`：107304 字节。
- `docs/s2-batch56-human-final.png`：123013 字节。
- `docs/s2-batch56-human-wait-proof.png`：115642 字节。
- `docs/s2-batch56-model-final.png`：117431 字节。
- `docs/s2-batch56-model-recheck.png`：126453 字节。
- `docs/s2-batch56-run-area-proof.png`：115759 字节。
- `docs/s2-batch56-sidebar-final.png`：117146 字节。
- `docs/s2-batch57-compact-help.png`：108832 字节。

## 另一对话正在新增的交互包接口或目录；未据此宣称迁移完成

32 个文件。

- `src/electron/sceneInteractionPackIpc.ts`：12 行。
  公开符号：`registerSceneInteractionPackIpc`（5）。
- `src/electron/sceneInteractionPackSeed.ts`：226 行。
  公开符号：`SCENE_PACK_SEED_RECEIPT`（9）、`createScenePackSeedManager`（82）。
- `src/electron/sceneInteractionPackStore.ts`：86 行。
  公开符号：`createSceneInteractionPackStore`（9）。
- `src/interaction-packs/prompt-lab/agentRules.ts`：7 行。
  公开符号：`promptLabAgentRules`（2）。
- `src/interaction-packs/prompt-lab/authoring.ts`：34 行。
  公开符号：`promptLabAuthoring`（18）。
- `src/interaction-packs/prompt-lab/composeControls.ts`：119 行。
  公开符号：`S2ComposeRow`（6）、`S2ComposeStructureConfig`（7）、`S2ComposeSlot`（8）、`s2ComposeStructure`（11）、`applyS2ComposeStructure`（44）、`s2ComposeControls`（61）、`applyS2ComposeControls`（94）。
- `src/interaction-packs/prompt-lab/ComposeEditor.tsx`：75 行。
  公开符号：`S2ComposeEditorProps`（5）、`S2ComposeEditor`（13）。
- `src/interaction-packs/prompt-lab/description.ts`：42 行。
  公开符号：`describePromptLab`（6）。
- `src/interaction-packs/prompt-lab/designPolicy.ts`：13 行。
  公开符号：`promptLabDesignPolicy`（2）。
- `src/interaction-packs/prompt-lab/entry.ts`：80 行。
  公开符号：`activate`（27）。
- `src/interaction-packs/prompt-lab/help.ts`：59 行。
  公开符号：`promptLabHelp`（2）。
- `src/interaction-packs/prompt-lab/index.ts`：22 行。
  公开符号：`promptLabPack`（9）。
- `src/interaction-packs/prompt-lab/manifest.ts`：6 行。
  公开符号：`promptLabManifest`（2）。
- `src/interaction-packs/prompt-lab/modelCapability.ts`：20 行。
  公开符号：`S2_MODEL_TEST_PLUGIN`（2）。
- `src/interaction-packs/prompt-lab/ModelParameters.tsx`：111 行。
  公开符号：`S2ModelParametersProps`（5）、`S2ModelParameters`（19）。
- `src/interaction-packs/prompt-lab/promptControls.ts`：226 行。
  公开符号：`S2PromptSection`（8）、`S2PromptPart`（9）、`S2_PROMPT_PART_LIMIT`（10）、`S2PromptRecoveryTarget`（11）、`S2PromptRecovery`（13）、`compileS2PromptSections`（91）、`inspectS2PromptControls`（112）、`setS2PromptPurpose`（126）；其余 5 项见JSON清单。
- `src/interaction-packs/prompt-lab/reactBridge.ts`：14 行。
  公开符号：`bindPromptLabReact`（3）、`useState`（8）、`useRef`（9）、`useEffect`（10）。
- `src/interaction-packs/prompt-lab/runtime.ts`：58 行。
  公开符号：`validatePromptLab`（4）、`createPromptLabRuntime`（20）。
- `src/interaction-packs/prompt-lab/styles.css`：19 行。
- `src/interaction-packs/prompt-lab/TemplateControls.tsx`：180 行。
  公开符号：`PromptTemplateControls`（5）、`promptTemplateHiddenInputs`（174）。
- `src/interaction-packs/prompt-lab/textTemplate.ts`：147 行。
  公开符号：`S2_TEXT_TEMPLATE_PLUGIN`（13）、`composeS2Text`（57）、`bindS2TextTemplateVariable`（88）、`renderS2TextTemplate`（97）、`executeS2TextTemplate`（121）。
- `src/interaction-packs/prompt-lab/uiHost.ts`：22 行。
  公开符号：`PromptLabUiHost`（5）、`bindPromptLabUiHost`（14）、`readS2Definition`（16）、`readS2Document`（17）、`snapshotS2CompositeData`（18）、`canonicalS2Json`（19）、`s2NodeTitle`（20）、`s2ParameterSource`（21）。
- `src/services/scene/sceneInteractionHostServices.ts`：152 行。
  公开符号：`createScenePackHostServices`（35）、`closeSceneInteractionHost`（84）、`enqueueSceneInteractionWorkflow`（92）、`enqueueSceneInteractionUserWorkflow`（129）、`scenePackLocalAdapter`（141）。
- `src/services/scene/sceneInteractionPackAssets.ts`：78 行。
  公开符号：`sceneInteractionPackAssets`（6）。
- `src/services/scene/sceneInteractionPackLoader.ts`：87 行。
  公开符号：`listSceneInteractionPacks`（31）、`loadSceneInteractionPack`（52）。
- `src/services/scene/sceneInteractionPackManifest.ts`：31 行。
  公开符号：`readSceneInteractionPackManifest`（6）、`readSceneInteractionPackRef`（23）。
- `src/services/scene/sceneInteractionPackMaterialProtocol.ts`：95 行。
  公开符号：`ScenePackMaterialError`（3）、`readScenePackMaterialDescriptors`（43）、`findScenePackMaterial`（60）、`verifyScenePackMaterialBytes`（70）。
- `src/services/scene/sceneInteractionPackMaterials.ts`：114 行。
  公开符号：`prepareScenePackMaterials`（27）、`setScenePackMaterialAvailability`（40）、`createScenePackMaterialScope`（50）、`executeScenePackLocal`（102）。
- `src/services/scene/sceneInteractionPackProtocol.ts`：308 行。
  公开符号：`readScenePackCanvasPolicy`（7）、`readScenePackAuthoringCatalog`（8）、`ScenePackProtocolError`（11）、`readScenePackDescription`（87）、`describeSceneInteractionPack`（120）、`readSceneInteractionPack`（177）、`readScenePackRuntime`（234）、`readScenePackViewPolicy`（240）；其余 3 项见JSON清单。
- `src/services/scene/sceneInteractionPackRegistry.ts`：45 行。
  公开符号：`readSceneInteractionPackManifest`（4）、`readSceneInteractionPackRef`（4）、`SceneInteractionPackRegistry`（7）。
- `src/services/scene/sceneInteractionPacks.ts`：8 行。
  公开符号：`sceneInteractionPacks`（5）、`DEFAULT_PROMPT_PACK`（7）。
- `src/types/sceneInteractionPack.ts`：236 行。
  公开符号：`SceneInteractionPackRef`（6）、`SceneInteractionPackManifestV1`（14）、`ScenePackMaterialMediaType`（15）、`ScenePackMaterialDescriptor`（17）、`SceneInteractionPackManifestV2`（25）、`SceneInteractionPackManifest`（29）、`ScenePackMaterialScope`（31）、`ScenePackExecutionContext`（37）；其余 20 项见JSON清单。

## S2 的正式应用入口与共享接入点，不应整份搬入交互包

20 个文件。

- `src/App.tsx`：3543 行。
  公开符号：`App`（285）。
- `src/components/scene/SceneBuilderPanel.tsx`：794 行。
  公开符号：`SceneBuilderPanel`（88）。
- `src/components/scene/ScenePackView.tsx`：58 行。
  公开符号：`scenePackViewPolicy`（8）、`scenePackView`（19）、`ScenePackView`（24）。
- `src/components/SceneMode.tsx`：979 行。
  公开符号：`SceneMode`（177）。
- `src/electron/apiHandlers.ts`：671 行。
  公开符号：`parseResponseDiagnostics`（87）、`normalizeAgentConversationMessages`（134）、`parseToolCalls`（168）、`normalizeToolsForProvider`（193）、`buildBody`（268）、`probeLlmRequest`（418）、`parseDiscoveredLlmModels`（445）、`discoverLlmModels`（470）；其余 3 项见JSON清单。
- `src/electron/ipcTypes.ts`：62 行。
  公开符号：`LlmIpcRequest`（9）、`LlmIpcResponse`（34）、`LlmModelDiscoveryResponse`（42）、`StreamChunkIpc`（49）、`AutoLinkIpcRequest`（57）。
- `src/services/llmHttpFailure.ts`：43 行。
  公开符号：`LlmHttpFailureReason`（15）、`safeLlmHttpError`（17）、`readSafeLlmHttpFailure`（37）。
- `src/services/llmImages.ts`：37 行。
  公开符号：`MAX_LLM_IMAGES`（4）、`MAX_LLM_IMAGE_BYTES`（5）、`LLM_IMAGE_TOKEN_RESERVE`（7）、`supportsImageInput`（8）、`validateLlmImages`（10）、`imageParts`（24）、`imageInputRejected`（33）。
- `src/services/llmService.ts`：400 行。
  公开符号：`LlmHttpError`（19）、`resolveProvider`（32）、`callLLM`（229）、`probeLlmProvider`（368）、`probeLlmConnection`（394）。
- `src/services/llmStorage.ts`：143 行。
  公开符号：`getDefaultLlmSettings`（17）、`loadLlmSettings`（64）、`getLlmSettingsLoadState`（115）、`subscribeLlmSettingsLoad`（116）、`ensureLlmSettingsLoaded`（117）、`retryLlmSettingsLoad`（118）、`readLlmSettingsForUse`（121）、`getLlmSettingsSaveState`（133）；其余 6 项见JSON清单。
- `src/services/scene/sceneContextBudget.ts`：147 行。
  公开符号：`SCENE_LOCAL_CONTEXT_LIMIT`（7）、`SceneContextBudgetDiagnostics`（8）、`SceneContextBudgetOptions`（16）、`SceneContextBudgetError`（20）、`isSceneContextWorkflow`（30）、`estimateSceneTextTokens`（32）、`estimateSceneRequestTokens`（38）、`fitSceneContextBudget`（46）；其余 1 项见JSON清单。
- `src/services/scene/sceneGenerator.ts`：1021 行。
  公开符号：`GenerateSceneOpts`（63）、`AdaptSceneOpts`（98）、`buildManifestPromptSection`（106）、`buildTopicSection`（139）、`parseSceneAgentInstructions`（229）、`SceneBuildCheckpoint`（239）、`SceneBuildInterruptedError`（257）、`parseSceneSpec`（270）；其余 6 项见JSON清单。
- `src/services/scene/scenePackAuthoringCatalog.ts`：158 行。
  公开符号：`ScenePackAuthoringCatalogError`（6）、`ScenePackAuthoringCatalogOptions`（11）、`readScenePackAuthoringCatalog`（99）。
- `src/services/scene/scenePackCanvasPolicy.ts`：145 行。
  公开符号：`ScenePackCanvasPolicyError`（5）、`ScenePackCanvasPolicyOptions`（10）、`readScenePackCanvasPolicy`（94）。
- `src/services/scene/scenePackEditorServices.ts`：12 行。
  公开符号：`scenePackEditorServices`（8）。
- `src/services/scene/sceneProjectNoteAccess.ts`：25 行。
  公开符号：`createSceneProjectNoteSource`（9）。
- `src/services/scene/sceneSkillStore.ts`：279 行。
  公开符号：`generateSceneId`（49）、`emptyManifest`（54）、`toManifestEntry`（59）、`normalizeSceneSpec`（93）、`loadManifest`（152）、`saveManifest`（177）、`listScenes`（185）、`loadScene`（194）；其余 6 项见JSON清单。
- `src/types.ts`：1953 行。
  公开符号：`NoteType`（5）、`GraphMode`（7）、`PlanTaskKind`（9）、`PlanExecutionKind`（10）、`PlanRecurrenceFrequency`（11）、`PlanStatus`（12）、`PlanStartingLevel`（13）、`PlanPace`（14）；其余 169 项见JSON清单。
- `src/types/scene.ts`：1097 行。
  公开符号：`SceneSkillType`（24）、`DialogueParadigm`（43）、`SceneOutputFormat`（49）、`SceneInteractionType`（57）、`SceneRecipeId`（66）、`SceneCapabilityId`（80）、`ScenePromptModuleId`（105）、`SceneInteractionProtocol`（121）；其余 80 项见JSON清单。
- `src/workflows/workflowRegistry.ts`：228 行。
  公开符号：`WORKFLOW_TEMPLATES`（32）、`getWorkflowById`（225）。

## S2 文件直接导入的共享应用模块，不是 S2 独占代码

3 个文件。

- `src/services/reviewSegmentScoring.ts`：137 行。
  公开符号：`ReviewSegment`（8）、`parseJsonLenient`（17）、`parseIntentMarker`（31）、`scoreReviewSegmentsInParallel`（44）、`mergeSegmentResults`（112）。
- `src/services/scene/sceneOutputSafety.ts`：8 行。
  公开符号：`isSceneOutputTruncated`（4）。
- `src/services/textbook/localImages.ts`：163 行。
  公开符号：`MAX_TEXTBOOK_IMAGE_BYTES`（2）、`PDF_PAGE_IMAGE_INDEX`（4）、`PDF_FORMULA_IMAGE_INDEX`（5）、`MAX_PDF_FORMULA_REGIONS`（6）、`MAX_TEXTBOOK_GIF_FRAMES`（9）、`MAX_TEXTBOOK_GIF_TOTAL_PIXELS`（10）、`isLocalRasterDataUrl`（127）、`embeddedLocalImages`（142）。

## 本次可重生成的源码盘点工具

1 个文件。

- `scripts/inventory-scene-s2.ts`：179 行。

## package 中的验证和预览命令

以下只记录命令定义，生成索引不会执行它们。真实模型运行器必须另获授权，不能把递归命令引用当作真实验收。

- `check:scene`：`node scripts/run-tsx-safe.cjs scripts/check-scene-paradigm.ts`
- `check:scene-s2`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-plugins.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-plugin-host.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-workflow.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-advanced.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-simulation.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-conditions.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-merge.tsx && npm run check:scene-s2-runtime-recovery && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-light-design.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-design.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-proposal-review.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-design-repair.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-design-consistency.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-agent-validation.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-targeted-validation.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-ui-agent-validation.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-context.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-business.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-assessment.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-business-interaction.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-human.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-ui.ts && node --require ./scripts/node-os-userinfo-fallback.cjs --import ./scripts/test-ui-assets.mjs --import tsx scripts/check-scene-s2-canvas.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-business-validation.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-live-safety.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-business-evidence.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-business-interaction-validation.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-evaluation-intent.ts && npm run check:scene-s2-text-template && npm run check:scene-s2-model-test && npm run check:scene-s2-artifacts && npm run check:scene-s2-iteration && npm run check:scene-s2-controls && npm run check:scene-s2-data-views`
- `check:scene-s2-runtime-recovery`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-runtime-issues.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-runtime-recovery-ui.tsx && npm run check:scene-s2-condition-recovery && npm run check:scene-s2-transform-recovery && npm run check:scene-s2-human-recovery && npm run check:scene-s2-model-recovery && npm run check:scene-s2-resource-recovery`
- `check:scene-s2-model-recovery`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-model-recovery.tsx`
- `check:scene-s2-resource-recovery`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-resource-recovery.tsx && npm run check:scene-s2-resource-content-recovery`
- `check:scene-s2-resource-content-recovery`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-resource-content-recovery.tsx`
- `check:scene-s2-transform-recovery`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-transform-issues.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-transform-recovery-ui.tsx && npm run check:scene-s2-table-recovery`
- `check:scene-s2-human-recovery`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-human-recovery.tsx`
- `check:scene-s2-table-recovery`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-table-recovery.tsx`
- `check:scene-s2-condition-recovery`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-condition-issues.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-condition-recovery-ui.tsx`
- `check:scene-s2-text-template`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-text-template.ts && npm run check:scene-s2-experiment`
- `check:scene-s2-experiment`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-content-blocks.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-content-name-ui.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-compose.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-model-parameters-ui.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-experiment.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-experiment-ui.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-natural-assistant.ts`
- `check:scene-s2-model-test`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-model-test.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-model-parameters.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-model-ui.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-model-boundary.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-model-lifecycle.ts`
- `check:scene-s2-artifacts`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-artifact-context.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-artifact-assessment.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-artifact-interaction.ts`
- `check:scene-s2-iteration`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-output-index.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-iteration.ts && npm run check:scene-s2-trials`
- `check:scene-s2-trials`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-trials.ts`
- `check:scene-s2-controls`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-controls.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-editable-issues.tsx && npm run check:scene-s2-field-integrity && npm run check:scene-s2-events`
- `check:scene-s2-events`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-events.ts && npm run check:scene-s2-control-lifecycle && npm run check:scene-s2-condition-view-lifecycle && npm run check:scene-s2-layout-events && npm run check:scene-s2-replacement`
- `check:scene-s2-replacement`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-replacement.ts`
- `check:scene-s2-layout-events`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-layout-events.ts`
- `check:scene-s2-condition-view-lifecycle`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-condition-view-lifecycle.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-condition-forms.tsx`
- `check:scene-s2-control-lifecycle`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-control-lifecycle.tsx`
- `check:scene-s2-field-integrity`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-field-integrity.ts`
- `check:scene-s2-data-views`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-data-views.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-result-reading.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-sidebar.tsx && npm run check:scene-s2-rich-controls`
- `check:scene-s2-rich-controls`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-rich-controls.ts && npm run check:scene-s2-presentation`
- `check:scene-s2-presentation`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-presentation.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-plugin-help.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-prompt-controls.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-prompt-recovery.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-template-layout.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-review-task.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-manual-reuse.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-manual-prompt.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-field-choices.tsx && npm run check:scene-s2-materials`
- `check:scene-s2-materials`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-materials.ts && npm run check:scene-s2-connections && npm run check:scene-s2-parameter-forms`
- `check:scene-s2-connections`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-connections.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-connection-ui.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-connection-issues.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-connection-recovery-ui.tsx`
- `check:scene-s2-parameter-forms`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-parameter-forms.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-simple-value-forms.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-record-forms.tsx && npm run check:scene-s2-run-summary`
- `check:scene-s2-run-summary`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-run-summary.tsx && npm run check:scene-s2-response-form`
- `check:scene-s2-response-form`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-response-form-contract.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-response-form.tsx && npm run check:scene-s2-registration`
- `check:scene-s2-registration`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-registration-integrity.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-installation.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-builtin-installation.tsx && npm run check:scene-s2-adapter-conformance && npm run check:scene-s2-text-resource && npm run check:scene-s2-project-notes && npm run check:scene-s2-composite`
- `check:scene-s2-adapter-conformance`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-adapter-conformance.ts`
- `check:scene-s2-text-resource`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-text-resource.ts`
- `check:scene-s2-project-notes`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-project-notes.ts`
- `check:scene-s2-composite`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-composite.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-composite-canvas.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-composite-nesting.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-composite-library.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-blueprint-design.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-composite-comparison.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-composite-instance.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-composite-migration.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-composite-copy.tsx && npm run check:scene-s2-output-reconnect`
- `check:scene-s2-output-reconnect`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-output-reconnect.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-output-reconnect-ui.tsx && npm run check:scene-s2-output-apply`
- `check:scene-s2-output-apply`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-output-apply.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-output-apply-ui.tsx`
- `check:scene-s2-browser`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-browser-protocol.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-browser-isolation.ts`
- `preview:scene-s2-browser`：`vite --config scripts/vite-s2-browser.config.ts`
- `check:scene-s2-readonly`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-readonly.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-readonly-host.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-readonly-design.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-readonly-prompt.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-readonly-ui.tsx`
- `check:scene-s2-pack-ui`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-inline-content.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-pack-ui-policy.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-compose-structure.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-text-material-input.tsx && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-five-blocks.tsx`
- `check:scene-s2-user-execution`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-user-action-model.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-user-action-boundary.ts && node scripts/run-tsx-safe.cjs --no-scene-pack-bootstrap scripts/check-scene-s2-canvas-delete.ts`
- `check:scene-s2-public-authoring`：`node scripts/run-tsx-safe.cjs --no-scene-pack-bootstrap scripts/check-scene-pack-authoring-contract.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-public-authoring.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-public-parameter-rules.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-public-builder.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-public-interface-ui.tsx && node scripts/run-tsx-safe.cjs --no-scene-pack-bootstrap scripts/check-scene-s2-agent-context-size.ts`
- `check:scene-s2-prompt-inline-browser`：`node scripts/run-tsx-safe.cjs scripts/check-scene-s2-prompt-inline-browser.ts`
- `check:scene-s2-build-context`：`node scripts/run-tsx-safe.cjs --no-scene-pack-bootstrap scripts/check-scene-s2-build-context.ts && node scripts/run-tsx-safe.cjs --no-scene-pack-bootstrap scripts/check-scene-s2-builder-catalog.ts && node scripts/run-tsx-safe.cjs --no-scene-pack-bootstrap scripts/check-scene-s2-design-disclosure.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-progressive-disclosure.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-builder-context-integration.ts && node scripts/run-tsx-safe.cjs scripts/check-scene-s2-discovery-scope.ts`

## 未进入 package 命令的 S2 检查

这些脚本可能已有单项运行记录；此处只表示没有被现有相关package命令引用，不表示失败，也不应被遗漏。

- `scripts/check-scene-s2-canvas-live-bridge.ts`
- `scripts/check-scene-s2-canvas-live-config.ts`
- `scripts/check-scene-s2-host-result-live-safety.ts`
- `scripts/check-scene-s2-host-result-validation.ts`
- `scripts/check-scene-s2-image-materials.tsx`
- `scripts/check-scene-s2-images.ts`
- `scripts/check-scene-s2-model-bridge.ts`
- `scripts/check-scene-s2-optional-assistant.ts`
- `scripts/check-scene-s2-pack-views-browser.ts`
- `scripts/check-scene-s2-task-replay.ts`
- `scripts/check-scene-s2-ui-evidence.ts`

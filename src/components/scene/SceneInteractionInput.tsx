import React, { useEffect, useId, useMemo, useState } from 'react';
import {
  ArrowDown, ArrowRight, ArrowUp, BarChart3, Check, GripVertical, Scale, Send, ShieldCheck,
} from 'lucide-react';
import type {
  SceneFillBlanksInteractionDirective,
  SceneInteractionDirective,
  SceneInteractionResponse,
  SceneMultipleChoiceInteractionDirective,
  SceneOrderingInteractionDirective,
  SceneQuestionSetAnswer,
  SceneQuestionSetInteractionDirective,
  SceneSingleChoiceInteractionDirective,
} from '../../types';
import { SceneRichMessage } from './SceneRichMessage';

type SupportedInteractionDirective =
  | SceneSingleChoiceInteractionDirective
  | SceneMultipleChoiceInteractionDirective
  | SceneOrderingInteractionDirective
  | SceneFillBlanksInteractionDirective
  | SceneQuestionSetInteractionDirective;

interface Props {
  directive: SupportedInteractionDirective;
  disabled?: boolean;
  choicePresentation?: 'strategy' | 'answer';
  onSubmit: (response: SceneInteractionResponse) => void;
}

interface ExplanationProps {
  id: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

const ExplanationField: React.FC<ExplanationProps> = ({ id, value, disabled, onChange }) => (
  <div className="scene-interaction-explanation">
    <label htmlFor={id}>补充理由（可选）</label>
    <textarea
      id={id}
      rows={2}
      value={value}
      disabled={disabled}
      placeholder="简要说明你的判断依据"
      onChange={(event) => onChange(event.target.value)}
    />
  </div>
);

const ChoiceInteractionInput: React.FC<Props & {
  directive: SceneSingleChoiceInteractionDirective | SceneMultipleChoiceInteractionDirective;
}> = ({ directive, disabled = false, choicePresentation = 'answer', onSubmit }) => {
  const [singleId, setSingleId] = useState('');
  const [multipleIds, setMultipleIds] = useState<string[]>([]);
  const [explanation, setExplanation] = useState('');
  const reactId = useId().replace(/:/g, '');

  useEffect(() => {
    setSingleId('');
    setMultipleIds([]);
    setExplanation('');
  }, [directive.id]);

  const constraints = useMemo(() => {
    if (directive.type === 'single-choice') return { min: 1, max: 1 };
    return {
      min: directive.minSelections || (directive.required ? 1 : 0),
      max: directive.maxSelections || directive.options.length,
    };
  }, [directive]);

  const selectedCount = directive.type === 'single-choice' ? (singleId ? 1 : 0) : multipleIds.length;
  const canSubmit = !disabled && selectedCount >= constraints.min && selectedCount <= constraints.max;

  const toggleMultiple = (id: string) => {
    setMultipleIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= constraints.max) return current;
      return [...current, id];
    });
  };

  const chooseOption = (id: string, checked: boolean, atLimit: boolean) => {
    if (disabled || (atLimit && !checked)) return;
    if (directive.type === 'single-choice') setSingleId(id);
    else toggleMultiple(id);
  };

  const moveSingleChoiceFocus = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (directive.type !== 'single-choice') return;
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const last = directive.options.length - 1;
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? last
        : event.key === 'ArrowRight' || event.key === 'ArrowDown'
          ? (index + 1) % directive.options.length
          : (index - 1 + directive.options.length) % directive.options.length;
    const next = directive.options[nextIndex];
    setSingleId(next.id);
    const group = event.currentTarget.parentElement;
    (group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex])?.focus();
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    const submittedAt = new Date().toISOString();
    if (directive.type === 'single-choice') {
      onSubmit({
        interactionId: directive.id,
        type: 'single-choice',
        selectedId: singleId,
        explanation: explanation.trim() || undefined,
        submittedAt,
      });
      return;
    }
    onSubmit({
      interactionId: directive.id,
      type: 'multiple-choice',
      selectedIds: multipleIds,
      explanation: explanation.trim() || undefined,
      submittedAt,
    });
  };

  const groupName = `scene-interaction-${reactId}`;
  return (
    <form className={`scene-interaction-input is-${choicePresentation}-choices`} aria-busy={disabled} onSubmit={submit}>
      <fieldset disabled={disabled}>
        <legend>{directive.instruction || (directive.type === 'single-choice' ? '请选择一个答案' : '请选择所有符合的答案')}</legend>
        <div
          className="scene-interaction-options"
          role={directive.type === 'single-choice' ? 'radiogroup' : 'group'}
          aria-label={directive.instruction || (directive.type === 'single-choice' ? '请选择一个答案' : '请选择所有符合的答案')}
        >
          {directive.options.map((option, index) => {
            const checked = directive.type === 'single-choice'
              ? singleId === option.id
              : multipleIds.includes(option.id);
            const atLimit = directive.type === 'multiple-choice' && multipleIds.length >= constraints.max;
            const StrategyIcon = [BarChart3, ShieldCheck, Scale][index % 3];
            return (
              <button
                type="button"
                key={option.id}
                role={directive.type === 'single-choice' ? 'radio' : 'checkbox'}
                aria-checked={checked}
                tabIndex={directive.type === 'single-choice' ? (checked || (!singleId && index === 0) ? 0 : -1) : 0}
                className={`scene-interaction-option is-${choicePresentation}-choice ${directive.type === 'single-choice' ? 'is-radio' : 'is-checkbox'} ${checked ? 'is-selected' : ''} ${atLimit && !checked ? 'is-limit-disabled' : ''}`}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  chooseOption(option.id, checked, atLimit);
                }}
                onKeyDown={(event) => {
                  moveSingleChoiceFocus(event, index);
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  chooseOption(option.id, checked, atLimit);
                }}
                disabled={disabled || (atLimit && !checked)}
              >
                <span className="scene-interaction-mark" aria-hidden="true">
                  {choicePresentation === 'strategy'
                    ? <StrategyIcon />
                    : <span className="scene-answer-letter">{String.fromCharCode(65 + index)}</span>}
                </span>
                <span className="scene-interaction-option-copy">
                  <span>{option.label}</span>
                  {option.description && <small>{option.description}</small>}
                </span>
                {choicePresentation === 'strategy' && (
                  <span className="scene-interaction-option-arrow" aria-hidden="true">
                    {checked ? <Check /> : <ArrowRight />}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </fieldset>

      {directive.type === 'multiple-choice' && (
        <div className="scene-interaction-count" aria-live="polite">
          已选 {selectedCount} 项{constraints.max < directive.options.length ? `，最多 ${constraints.max} 项` : ''}
        </div>
      )}

      {directive.allowExplanation && (
        <ExplanationField
          id={`${groupName}-explanation`}
          value={explanation}
          disabled={disabled}
          onChange={setExplanation}
        />
      )}

      <button type="submit" className="scene-btn scene-btn--primary scene-interaction-submit" disabled={!canSubmit}>
        <Send className="w-4 h-4" />
        提交选择
      </button>
    </form>
  );
};

const FillBlanksInteractionInput: React.FC<Props & {
  directive: SceneFillBlanksInteractionDirective;
}> = ({ directive, disabled = false, onSubmit }) => {
  const reactId = useId().replace(/:/g, '');
  const [values, setValues] = useState<Record<string, string>>(
    () => Object.fromEntries(directive.blanks.map((blank) => [blank.id, ''])),
  );
  const [explanation, setExplanation] = useState('');

  useEffect(() => {
    setValues(Object.fromEntries(directive.blanks.map((blank) => [blank.id, ''])));
    setExplanation('');
  }, [directive.id, directive.blanks]);

  const completedCount = directive.blanks.filter((blank) => values[blank.id]?.trim()).length;
  const canSubmit = !disabled && (!directive.required || completedCount === directive.blanks.length);
  const groupId = `scene-interaction-${reactId}`;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      interactionId: directive.id,
      type: 'fill-blanks',
      values: Object.fromEntries(directive.blanks.map((blank) => [blank.id, values[blank.id]?.trim() || ''])),
      explanation: explanation.trim() || undefined,
      submittedAt: new Date().toISOString(),
    });
  };

  return (
    <form className="scene-interaction-input" aria-busy={disabled} onSubmit={submit}>
      <fieldset disabled={disabled}>
        <legend>{directive.instruction || '请填写以下内容'}</legend>
        <div className="scene-interaction-blanks">
          {directive.blanks.map((blank, index) => {
            const inputId = `${groupId}-blank-${index}`;
            return (
              <div key={blank.id} className="scene-interaction-blank">
                <label htmlFor={inputId}>
                  {blank.label || `空 ${index + 1}`}
                  {directive.required && <span aria-hidden="true"> *</span>}
                </label>
                <input
                  id={inputId}
                  type="text"
                  required={directive.required}
                  value={values[blank.id] || ''}
                  placeholder={blank.placeholder || '请输入答案'}
                  onChange={(event) => setValues((current) => ({ ...current, [blank.id]: event.target.value }))}
                />
              </div>
            );
          })}
        </div>
      </fieldset>

      <div className="scene-interaction-count" aria-live="polite">
        已填写 {completedCount} / {directive.blanks.length}
      </div>

      {directive.allowExplanation && (
        <ExplanationField
          id={`${groupId}-explanation`}
          value={explanation}
          disabled={disabled}
          onChange={setExplanation}
        />
      )}

      <button type="submit" className="scene-btn scene-btn--primary scene-interaction-submit" disabled={!canSubmit}>
        <Send className="w-4 h-4" />
        提交填空
      </button>
    </form>
  );
};

const OrderingInteractionInput: React.FC<Props & {
  directive: SceneOrderingInteractionDirective;
}> = ({ directive, disabled = false, onSubmit }) => {
  const reactId = useId().replace(/:/g, '');
  const [orderedIds, setOrderedIds] = useState<string[]>(() => directive.items.map((item) => item.id));
  const [explanation, setExplanation] = useState('');
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    setOrderedIds(directive.items.map((item) => item.id));
    setExplanation('');
    setAnnouncement('');
  }, [directive.id, directive.items]);

  const move = (index: number, offset: -1 | 1) => {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= orderedIds.length) return;
    const next = [...orderedIds];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    setOrderedIds(next);
    const item = directive.items.find((candidate) => candidate.id === next[nextIndex]);
    setAnnouncement(`${item?.content || '当前项目'}已${offset < 0 ? '上移' : '下移'}到第 ${nextIndex + 1} 位`);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (disabled || orderedIds.length !== directive.items.length) return;
    onSubmit({
      interactionId: directive.id,
      type: 'ordering',
      orderedIds,
      explanation: explanation.trim() || undefined,
      submittedAt: new Date().toISOString(),
    });
  };

  const groupId = `scene-interaction-${reactId}`;
  return (
    <form className="scene-interaction-input" aria-busy={disabled} onSubmit={submit}>
      <fieldset disabled={disabled}>
        <legend>{directive.instruction || '请调整为正确顺序'}</legend>
        <ol className="scene-interaction-ordering">
          {orderedIds.map((id, index) => {
            const item = directive.items.find((candidate) => candidate.id === id);
            if (!item) return null;
            return (
              <li key={id} className="scene-interaction-order-item">
                <span className="scene-interaction-order-index" aria-hidden="true">{index + 1}</span>
                <GripVertical className="scene-interaction-order-grip" aria-hidden="true" />
                <span className="scene-interaction-order-content">{item.content}</span>
                <div className="scene-interaction-order-actions">
                  <button type="button" disabled={disabled || index === 0} onClick={() => move(index, -1)} aria-label={`将“${item.content}”上移`}>
                    <ArrowUp />
                  </button>
                  <button type="button" disabled={disabled || index === orderedIds.length - 1} onClick={() => move(index, 1)} aria-label={`将“${item.content}”下移`}>
                    <ArrowDown />
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      </fieldset>

      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>

      {directive.allowExplanation && (
        <ExplanationField
          id={`${groupId}-explanation`}
          value={explanation}
          disabled={disabled}
          onChange={setExplanation}
        />
      )}

      <button type="submit" className="scene-btn scene-btn--primary scene-interaction-submit" disabled={disabled || orderedIds.length !== directive.items.length}>
        <Send className="w-4 h-4" />
        提交排序
      </button>
    </form>
  );
};

const QuestionSetInteractionInput: React.FC<Props & {
  directive: SceneQuestionSetInteractionDirective;
}> = ({ directive, disabled = false, onSubmit }) => {
  const reactId = useId().replace(/:/g, '');
  const [answers, setAnswers] = useState<Record<string, string[]>>({});

  useEffect(() => {
    setAnswers({});
  }, [directive.id]);

  const isItemComplete = (item: SceneQuestionSetInteractionDirective['items'][number]) => {
    const selected = answers[item.id] || [];
    if (!item.required && selected.length === 0) return true;
    if (item.type === 'multiple-choice') {
      const minimum = item.minSelections || (item.required ? 1 : 0);
      const maximum = item.maxSelections || item.options.length;
      return selected.length >= minimum && selected.length <= maximum;
    }
    return selected.length === 1;
  };
  const completedCount = directive.items.filter((item) => (answers[item.id] || []).length > 0).length;
  const canSubmit = !disabled && directive.items.every(isItemComplete);

  const setSingleAnswer = (itemId: string, value: string) => {
    setAnswers((current) => ({ ...current, [itemId]: [value] }));
  };
  const toggleMultipleAnswer = (itemId: string, value: string, maximum: number) => {
    setAnswers((current) => {
      const selected = current[itemId] || [];
      if (selected.includes(value)) {
        return { ...current, [itemId]: selected.filter((candidate) => candidate !== value) };
      }
      if (selected.length >= maximum) return current;
      return { ...current, [itemId]: [...selected, value] };
    });
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    const normalizedAnswers: SceneQuestionSetAnswer[] = [];
    directive.items.forEach((item) => {
      const selected = answers[item.id] || [];
      if (selected.length === 0) return;
      if (item.type === 'true-false') {
        normalizedAnswers.push({ itemId: item.id, type: item.type, value: selected[0] === 'true' });
        return;
      }
      if (item.type === 'single-choice') {
        normalizedAnswers.push({ itemId: item.id, type: item.type, selectedId: selected[0] });
        return;
      }
      normalizedAnswers.push({ itemId: item.id, type: item.type, selectedIds: selected });
    });
    onSubmit({
      interactionId: directive.id,
      type: 'question-set',
      answers: normalizedAnswers,
      submittedAt: new Date().toISOString(),
    });
  };

  return (
    <form className="scene-interaction-input scene-question-set" aria-busy={disabled} onSubmit={submit}>
      <header className="scene-question-set-header">
        <div>
          <h3>{directive.title || '题组作答'}</h3>
          {directive.description && <p>{directive.description}</p>}
        </div>
        <span className="scene-question-set-progress" aria-live="polite">
          已作答 {completedCount} / {directive.items.length}
        </span>
      </header>

      <div className="scene-question-set-items">
        {directive.items.map((item, itemIndex) => {
          const selected = answers[item.id] || [];
          const groupName = `scene-question-set-${reactId}-${itemIndex}`;
          const options = item.type === 'true-false'
            ? [
                { id: 'true', label: item.trueLabel || '对' },
                { id: 'false', label: item.falseLabel || '错' },
              ]
            : item.options;
          const maximum = item.type === 'multiple-choice'
            ? (item.maxSelections || item.options.length)
            : 1;
          return (
            <fieldset key={item.id} className="scene-question-card" disabled={disabled}>
              <legend>
                第 {itemIndex + 1} 题
                {item.required && <span className="scene-question-required">必答</span>}
                <span className="scene-question-type">
                  {item.type === 'multiple-choice' ? '多选' : item.type === 'true-false' ? '判断' : '单选'}
                </span>
              </legend>
              <div className="scene-question-content">
                <SceneRichMessage content={item.content} />
              </div>
              <div className="scene-interaction-options">
                {options.map((option, optionIndex) => {
                  const checked = selected.includes(option.id);
                  const optionId = `${groupName}-${optionIndex}`;
                  const atLimit = item.type === 'multiple-choice' && selected.length >= maximum;
                  return (
                    <label
                      key={option.id}
                      htmlFor={optionId}
                      className={`scene-interaction-option ${checked ? 'is-selected' : ''} ${atLimit && !checked ? 'is-limit-disabled' : ''}`}
                    >
                      <input
                        id={optionId}
                        name={groupName}
                        type={item.type === 'multiple-choice' ? 'checkbox' : 'radio'}
                        checked={checked}
                        disabled={disabled || (atLimit && !checked)}
                        onChange={() => item.type === 'multiple-choice'
                          ? toggleMultipleAnswer(item.id, option.id, maximum)
                          : setSingleAnswer(item.id, option.id)}
                      />
                      <span className="scene-interaction-mark" aria-hidden="true">{checked && <Check />}</span>
                      <span className="scene-interaction-option-copy">
                        <span>{option.label}</span>
                        {'description' in option && option.description && <small>{option.description}</small>}
                      </span>
                    </label>
                  );
                })}
              </div>
              {item.type === 'multiple-choice' && (
                <div className="scene-interaction-count" aria-live="polite">
                  已选 {selected.length} 项{maximum < item.options.length ? `，最多 ${maximum} 项` : ''}
                </div>
              )}
            </fieldset>
          );
        })}
      </div>

      <footer className="scene-question-set-actions">
        <span>{canSubmit ? '全部必答题已完成，可以统一交卷' : `还需完成 ${directive.items.filter((item) => !isItemComplete(item)).length} 道必答题`}</span>
        <button type="submit" className="scene-btn scene-btn--primary scene-interaction-submit" disabled={!canSubmit}>
          <Send className="w-4 h-4" />
          提交整卷
        </button>
      </footer>
    </form>
  );
};

/** 结构化回合输入适配器；按协议类型分派到对应的可访问表单。 */
export const SceneInteractionInput: React.FC<Props> = (props) => {
  if (props.directive.type === 'question-set') {
    return <QuestionSetInteractionInput {...props} directive={props.directive} />;
  }
  if (props.directive.type === 'single-choice' || props.directive.type === 'multiple-choice') {
    return <ChoiceInteractionInput {...props} directive={props.directive} />;
  }
  if (props.directive.type === 'ordering') {
    return <OrderingInteractionInput {...props} directive={props.directive} />;
  }
  return <FillBlanksInteractionInput {...props} directive={props.directive} />;
};

/** 当前客户端是否能渲染该结构化指令；text 仍由原输入框处理。 */
export function isSupportedStructuredInteraction(
  directive?: SceneInteractionDirective,
): directive is SupportedInteractionDirective {
  return directive?.type === 'single-choice'
    || directive?.type === 'multiple-choice'
    || directive?.type === 'ordering'
    || directive?.type === 'fill-blanks'
    || directive?.type === 'question-set';
}

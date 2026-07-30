import { useMutation, useQuery } from '@tanstack/react-query';
import { RefreshCw, Save, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Platform } from '../../api/contracts';
import { api } from '../../api/client';
import { EmptyState, ErrorState, IconButton, LoadingState, Section, SuccessNotice } from '../../components/ui';

type CustomSelection = { label: string; input: Record<string, string> };
type BuilderValue = string | string[] | boolean | { min?: string; max?: string } | { value: string; pathLabels: string[] } | CustomSelection;
type BuilderValues = Record<string, BuilderValue>;

function isCustomSelection(value: BuilderValue | undefined): value is CustomSelection {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && 'label' in value && 'input' in value;
}

function isRangeValue(value: BuilderValue | undefined): value is { min?: string; max?: string } {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && ('min' in value || 'max' in value);
}

function hasBuilderValue(value: BuilderValue): boolean {
  if (typeof value === 'string') return Boolean(value.trim());
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length > 0;
  if ('value' in value) return Boolean(value.value.trim());
  if ('label' in value) return Object.values(value.input).some((item) => item.trim());
  return Object.values(value).some(Boolean);
}

export function FilterBuilder({ platform, onSaved }: { platform?: Platform; onSaved: (path: string) => void }) {
  const [values, setValues] = useState<BuilderValues>({});
  const query = useQuery({
    queryKey: ['application-filter-options', platform],
    queryFn: ({ signal }) => api.getApplicationFilterOptions(platform!, signal),
    enabled: Boolean(platform),
  });
  const fields = useMemo(() => query.data ? query.data.fieldIds.map((id) => query.data!.fieldsById[id]).filter(Boolean) : [], [query.data]);
  const payload = useMemo(() => Object.fromEntries(Object.entries(values).filter(([, value]) => hasBuilderValue(value))), [values]);
  const mutation = useMutation({
    mutationFn: () => api.saveApplicationFilterInput({ platform, label: `client-${platform}`, applicationFilterInput: payload }),
    onSuccess: (result) => onSaved(result.path),
  });
  const setValue = (fieldId: string, value: BuilderValue | undefined) => setValues((current) => {
    const next = { ...current };
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) delete next[fieldId]; else next[fieldId] = value;
    return next;
  });

  if (!platform) return <Section title="可视化筛选"><EmptyState title="选择单个平台后构建筛选" description="全部平台不能共用一份平台筛选文件。" /></Section>;
  return (
    <Section title="可视化筛选" description="读取平台最新 application-filter-options，并生成经过服务端校验的筛选文件。" actions={<IconButton label="刷新筛选目录" onClick={() => void query.refetch()}><RefreshCw size={16} /></IconButton>}>
      {query.isLoading && <LoadingState label="读取筛选选项" />}
      {query.error && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      <div className="form-grid">
        {fields.map((field) => {
          const current = values[field.fieldId];
          if (field.kind === 'singleSelect') {
            const selected = isCustomSelection(current) ? current.label : typeof current === 'string' ? current : '';
            const custom = isCustomSelection(current) ? current : undefined;
            return <div key={field.fieldId} className="filter-range"><label><span>{field.label}</span><select value={selected} onChange={(event) => {
              const option = field.options.find((item) => item.value === event.target.value || item.label === event.target.value);
              setValue(field.fieldId, option?.inputSpec ? { label: option.label, input: {} } : event.target.value);
            }}><option value="">不限</option>{field.options.filter((option) => !option.disabled).map((option) => <option key={`${option.label}-${option.value}`} value={option.value || option.label}>{option.label}</option>)}</select></label>
              {custom && field.customInput && <div>{field.customInput.inputSpec.fields.map((input) => <span key={input.key}><input list={input.options?.length ? `custom-${field.fieldId}-${input.key}` : undefined} value={custom.input[input.key] ?? ''} placeholder={input.placeholder ?? input.label ?? input.key} onChange={(event) => setValue(field.fieldId, { ...custom, input: { ...custom.input, [input.key]: event.target.value } })} />{input.options?.length ? <datalist id={`custom-${field.fieldId}-${input.key}`}>{input.options.map((option) => <option key={option} value={option} />)}</datalist> : null}</span>)}</div>}
            </div>;
          }
          if (field.kind === 'multiSelect') {
            const selected = Array.isArray(current) ? current : [];
            return <fieldset key={field.fieldId} className="filter-range"><legend>{field.label}</legend>{field.options.filter((option) => !option.disabled).map((option) => {
              const value = option.value || option.label;
              const checked = selected.includes(value);
              return <label key={`${option.label}-${value}`}><input type="checkbox" checked={checked} onChange={() => setValue(field.fieldId, checked ? selected.filter((item) => item !== value) : [...selected, value])} />{option.label}</label>;
            })}</fieldset>;
          }
          if (field.kind === 'toggle') return <label key={field.fieldId}><span>{field.label}</span><input type="checkbox" checked={current === true} onChange={(event) => setValue(field.fieldId, event.target.checked)} /></label>;
          if (field.kind === 'textInput') {
            const id = `filter-${field.fieldId}`;
            const allowed = field.tree.flatMap((node) => node.children.length ? node.children : [node]);
            const value = typeof current === 'object' && current && !Array.isArray(current) && 'value' in current ? current.value : typeof current === 'string' ? current : '';
            return <label key={field.fieldId}><span>{field.label}</span><input list={id} value={value} onChange={(event) => { const match = allowed.find((item) => item.key === event.target.value || item.label === event.target.value); const nextValue = match?.key ?? event.target.value; setValue(field.fieldId, match ? { value: nextValue, pathLabels: match.pathLabels } : nextValue); }} /><datalist id={id}>{allowed.slice(0, 300).map((item) => <option key={`${item.key}-${item.pathLabels.join('/')}`} value={item.key}>{item.pathLabels.join(' / ')}</option>)}</datalist></label>;
          }
          const range = isRangeValue(current) ? current : {};
          return <div className="filter-range" key={field.fieldId}><span>{field.label}</span><div><input list={`min-${field.fieldId}`} value={range.min ?? ''} onChange={(event) => setValue(field.fieldId, { ...range, min: event.target.value })} placeholder={field.minLabel} /><input list={`max-${field.fieldId}`} value={range.max ?? ''} onChange={(event) => setValue(field.fieldId, { ...range, max: event.target.value })} placeholder={field.maxLabel} /><button className="icon-button" type="button" aria-label={`清除${field.label}`} onClick={() => setValue(field.fieldId, undefined)}><X size={15} /></button></div><datalist id={`min-${field.fieldId}`}>{field.minOptions.map((item) => <option key={item} value={item} />)}</datalist><datalist id={`max-${field.fieldId}`}>{field.maxOptions.map((item) => <option key={item} value={item} />)}</datalist></div>;
        })}
      </div>
      {fields.length > 0 && <div className="form-actions"><span>{Object.keys(payload).length} 个已选字段</span><button className="primary-button" type="button" disabled={mutation.isPending || Object.keys(payload).length === 0} onClick={() => mutation.mutate()}><Save size={16} />生成筛选文件</button></div>}
      {mutation.error && <ErrorState error={mutation.error} />}
      {mutation.data && <SuccessNotice>已生成 {mutation.data.path}</SuccessNotice>}
    </Section>
  );
}

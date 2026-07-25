import { useMutation, useQuery } from '@tanstack/react-query';
import { RefreshCw, Save, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Platform } from '../../api/contracts';
import { api } from '../../api/client';
import { EmptyState, ErrorState, IconButton, LoadingState, Section, SuccessNotice } from '../../components/ui';

type BuilderValues = Record<string, string | { min?: string; max?: string } | { value: string; pathLabels: string[] }>;

export function FilterBuilder({ platform, onSaved }: { platform?: Platform; onSaved: (path: string) => void }) {
  const [values, setValues] = useState<BuilderValues>({});
  const query = useQuery({
    queryKey: ['application-filter-options', platform],
    queryFn: ({ signal }) => api.getApplicationFilterOptions(platform!, signal),
    enabled: Boolean(platform),
  });
  const fields = useMemo(() => query.data ? query.data.fieldIds.map((id) => query.data!.fieldsById[id]).filter(Boolean) : [], [query.data]);
  const payload = useMemo(() => Object.fromEntries(Object.entries(values).filter(([, value]) => typeof value === 'string' ? value.trim() : Object.values(value).some(Boolean))), [values]);
  const mutation = useMutation({
    mutationFn: () => api.saveApplicationFilterInput({ platform, label: `client-${platform}`, applicationFilterInput: payload }),
    onSuccess: (result) => onSaved(result.path),
  });
  const setValue = (fieldId: string, value: BuilderValues[string] | undefined) => setValues((current) => {
    const next = { ...current };
    if (value === undefined || value === '') delete next[fieldId]; else next[fieldId] = value;
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
          if (field.kind === 'singleSelect') return <label key={field.fieldId}><span>{field.label}</span><select value={typeof current === 'string' ? current : ''} onChange={(event) => setValue(field.fieldId, event.target.value)}><option value="">不限</option>{field.options.filter((option) => !option.disabled).map((option) => <option key={`${option.label}-${option.value}`} value={option.value || option.label}>{option.label}</option>)}</select></label>;
          if (field.kind === 'textInput') {
            const id = `filter-${field.fieldId}`;
            const allowed = field.tree.flatMap((node) => node.children.length ? node.children : [node]);
            const value = typeof current === 'object' && 'value' in current ? current.value : typeof current === 'string' ? current : '';
            return <label key={field.fieldId}><span>{field.label}</span><input list={id} value={value} onChange={(event) => { const match = allowed.find((item) => item.key === event.target.value || item.label === event.target.value); const nextValue = match?.key ?? event.target.value; setValue(field.fieldId, match ? { value: nextValue, pathLabels: match.pathLabels } : event.target.value); }} /><datalist id={id}>{allowed.slice(0, 300).map((item) => <option key={`${item.key}-${item.pathLabels.join('/')}`} value={item.key}>{item.pathLabels.join(' / ')}</option>)}</datalist></label>;
          }
          const range = typeof current === 'object' && 'min' in current ? current : {};
          const minOptions = field.minOptions;
          const maxOptions = field.maxOptions;
          return <div className="filter-range" key={field.fieldId}><span>{field.label}</span><div><input list={`min-${field.fieldId}`} value={range.min ?? ''} onChange={(event) => setValue(field.fieldId, { ...range, min: event.target.value })} placeholder={field.minLabel} /><input list={`max-${field.fieldId}`} value={range.max ?? ''} onChange={(event) => setValue(field.fieldId, { ...range, max: event.target.value })} placeholder={field.maxLabel} /><button className="icon-button" type="button" aria-label={`清除${field.label}`} onClick={() => setValue(field.fieldId, undefined)}><X size={15} /></button></div><datalist id={`min-${field.fieldId}`}>{minOptions.map((item) => <option key={item} value={item} />)}</datalist><datalist id={`max-${field.fieldId}`}>{maxOptions.map((item) => <option key={item} value={item} />)}</datalist></div>;
        })}
      </div>
      {fields.length > 0 && <div className="form-actions"><span>{Object.keys(payload).length} 个已选字段</span><button className="primary-button" type="button" disabled={mutation.isPending || Object.keys(payload).length === 0} onClick={() => mutation.mutate()}><Save size={16} />生成筛选文件</button></div>}
      {mutation.error && <ErrorState error={mutation.error} />}
      {mutation.data && <SuccessNotice>已生成 {mutation.data.path}</SuccessNotice>}
    </Section>
  );
}

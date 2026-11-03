import type { PluginQuotaMetric } from '@/types';
export const formatMetric = (metric: PluginQuotaMetric): string => {
  const value =
    metric.format === 'currency' && metric.currency
      ? new Intl.NumberFormat(undefined, { style: 'currency', currency: metric.currency }).format(
          metric.value
        )
      : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(metric.value);
  return metric.unit ? `${value} ${metric.unit}` : value;
};

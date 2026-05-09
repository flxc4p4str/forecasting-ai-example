import { HttpClient, httpResource } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';

export interface ForecastSummary {
  id: number;
  original_filename: string;
  status: string;
  created_at: string;
  error_message: string | null;
}

export interface ForecastProduct {
  dbId: number;
  itemCode: string;
  label: string;
  profile: {
    brand: string;
    type: string;
    description: string;
    retailPrice: string;
    itemCode: string;
  };
  thisYearForecast: number[];
  lastYearForecast: number[];
  lastYearActual: number[];
}

export interface ForecastFinding {
  type: 'consideration' | 'recommendation' | string;
  description: string;
  impact: number;
}

export type ForecastFindingPayload = Record<string, Record<string, ForecastFinding[]>>;

export interface ForecastWorkspace {
  forecast: ForecastSummary;
  months: string[];
  products: ForecastProduct[];
  values_by_product: Record<string, Record<string, number>>;
  findings: ForecastFindingPayload;
}

export interface AIJob {
  id: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | string;
  forecast_upload_id: number;
  error_message: string | null;
  findings_count: number;
  findings: ForecastFindingPayload;
}

export interface AIJobCreate {
  forecast_context: string;
  blind_spots: string;
}

@Injectable({ providedIn: 'root' })
export class ForecastApi {
  private readonly http = inject(HttpClient);
  readonly workspaceResource = httpResource<ForecastWorkspace>(() => '/api/forecast');

  uploadForecast(file: File) {
    const formData = new FormData();
    formData.append('forecast_file', file);
    return this.http.post<ForecastWorkspace>('/api/forecasts', formData);
  }

  startAiJob(payload: AIJobCreate) {
    console.log('payload', payload);
    return this.http.post<AIJob>('/api/ai-jobs', payload);
  }

  getAiJob(jobId: number) {
    return this.http.get<AIJob>(`/api/ai-jobs/${jobId}`);
  }
}

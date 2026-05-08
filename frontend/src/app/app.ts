import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  ViewChild,
  inject,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Chart, Plugin, registerables } from 'chart.js';
import { Subscription, switchMap, timer } from 'rxjs';

import {
  AIJob,
  ForecastApi,
  ForecastFinding,
  ForecastFindingPayload,
  ForecastProduct,
  ForecastWorkspace,
} from './forecast-api';

Chart.register(...registerables);

interface MarkerHitbox {
  x: number;
  y: number;
  key: string;
  month: string;
  findings: ForecastFinding[];
}

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit, AfterViewInit, OnDestroy {
  private readonly api = inject(ForecastApi);
  private readonly findingMarkerPlugin: Plugin<'line'> = {
    id: 'forecastFindingMarkers',
    afterDraw: (chart) => this.drawFindingMarkers(chart),
  };

  @ViewChild('forecastCanvas') private forecastCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('findingTooltip') private findingTooltip?: ElementRef<HTMLDivElement>;
  @ViewChild('forecastFileInput') private forecastFileInput?: ElementRef<HTMLInputElement>;

  workspace?: ForecastWorkspace;
  selectedProduct?: ForecastProduct;
  findings: ForecastFindingPayload = {};
  markerHitboxes: MarkerHitbox[] = [];

  selectedUploadFile?: File;
  isLoading = true;
  isUploading = false;
  loadError = '';
  uploadError = '';

  isAiModalOpen = false;
  isAiSubmitting = false;
  aiStatusText = '';
  aiStatusClass = '';
  forecastContext = '';
  blindSpots = '';

  tooltipOpen = false;
  tooltipLeft = 0;
  tooltipTop = 0;
  tooltipMonth = '';
  tooltipConsiderations: ForecastFinding[] = [];
  tooltipRecommendations: ForecastFinding[] = [];
  private openMarkerKey: string | null = null;

  private chart?: Chart<'line', number[], string>;
  private aiPoll?: Subscription;

  ngOnInit(): void {
    this.api.getForecast().subscribe({
      next: (workspace) => {
        this.isLoading = false;
        this.applyWorkspace(workspace);
      },
      error: () => {
        this.isLoading = false;
        this.loadError = 'Forecast data could not be loaded. Make sure the Express API server is running.';
      },
    });
  }

  ngAfterViewInit(): void {
    this.refreshChart();
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
    this.aiPoll?.unsubscribe();
  }

  selectProduct(product: ForecastProduct): void {
    this.selectedProduct = product;
    this.closeTooltip();
    this.refreshChart();
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.selectedUploadFile = input.files?.[0] ?? undefined;
    this.uploadError = '';
  }

  uploadForecast(): void {
    if (!this.selectedUploadFile || this.isUploading) {
      return;
    }

    this.isUploading = true;
    this.uploadError = '';
    this.api.uploadForecast(this.selectedUploadFile).subscribe({
      next: (workspace) => {
        this.isUploading = false;
        this.selectedUploadFile = undefined;
        this.forecastFileInput?.nativeElement.form?.reset();
        this.applyWorkspace(workspace);
      },
      error: (error: HttpErrorResponse) => {
        this.isUploading = false;
        this.selectedUploadFile = undefined;
        this.forecastFileInput?.nativeElement.form?.reset();
        const workspace = error.error as ForecastWorkspace | undefined;
        if (workspace?.forecast) {
          this.applyWorkspace(workspace);
          this.uploadError = workspace.forecast.error_message ?? 'Forecast CSV could not be applied.';
          return;
        }
        this.uploadError = 'Forecast CSV could not be applied.';
      },
    });
  }

  openAiModal(): void {
    this.isAiModalOpen = true;
  }

  closeAiModal(): void {
    if (!this.isAiSubmitting) {
      this.isAiModalOpen = false;
    }
  }

  startAiAnalysis(): void {
    if (this.isAiSubmitting) {
      return;
    }

    this.isAiSubmitting = true;
    this.aiStatusClass = 'running';
    this.aiStatusText = 'Queuing analysis...';
    this.api
      .startAiJob({
        forecast_context: this.forecastContext,
        blind_spots: this.blindSpots,
      })
      .subscribe({
        next: (job) => {
          this.isAiSubmitting = false;
          this.isAiModalOpen = false;
          this.aiStatusClass = job.status;
          this.aiStatusText = 'Analyzing forecast...';
          this.pollAiJob(job.id);
        },
        error: () => {
          this.isAiSubmitting = false;
          this.aiStatusClass = 'failed';
          this.aiStatusText = 'AI analysis could not be started.';
        },
      });
  }

  handleCanvasClick(event: MouseEvent): void {
    const canvas = this.forecastCanvas?.nativeElement;
    if (!canvas) {
      return;
    }

    const bounds = canvas.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const nearby = this.markerHitboxes.find((hitbox) => Math.hypot(hitbox.x - x, hitbox.y - y) <= 22);

    if (nearby) {
      this.toggleTooltip(nearby);
      this.chart?.update();
      return;
    }

    this.closeTooltip();
    this.chart?.update();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.tooltipOpen) {
      return;
    }

    const target = event.target as Node | null;
    const canvas = this.forecastCanvas?.nativeElement;
    const tooltip = this.findingTooltip?.nativeElement;
    if (!target || canvas?.contains(target) || tooltip?.contains(target)) {
      return;
    }

    this.closeTooltip();
    this.chart?.update();
  }

  impactEmoji(impact: number): string {
    if (impact <= -3) return '📉';
    if (impact < 0) return '↘️';
    if (impact === 0) return '⚪';
    if (impact < 3) return '↗️';
    return '📈';
  }

  signedImpact(impact: number): string {
    return impact > 0 ? `+${impact}` : String(impact);
  }

  forecastValue(productId: number, month: string): number | string {
    return this.workspace?.values_by_product[String(productId)]?.[month] ?? '';
  }

  private applyWorkspace(workspace: ForecastWorkspace): void {
    const previousProductId = this.selectedProduct?.dbId;
    this.workspace = workspace;
    this.findings = workspace.findings ?? {};
    this.selectedProduct =
      workspace.products.find((product) => product.dbId === previousProductId) ?? workspace.products[0];
    this.closeTooltip();
    this.refreshChart();
  }

  private refreshChart(): void {
    if (!this.forecastCanvas || !this.workspace || !this.selectedProduct) {
      return;
    }

    if (!this.chart) {
      this.chart = this.createChart();
      return;
    }

    this.chart.data.labels = this.workspace.months;
    this.chart.data.datasets[0].data = this.selectedProduct.thisYearForecast;
    this.chart.data.datasets[1].data = this.selectedProduct.lastYearForecast;
    this.chart.data.datasets[2].data = this.selectedProduct.lastYearActual;
    this.chart.update();
  }

  private createChart(): Chart<'line', number[], string> {
    const canvas = this.forecastCanvas?.nativeElement;
    if (!canvas || !this.workspace || !this.selectedProduct) {
      throw new Error('Chart cannot be initialized before forecast data is ready.');
    }

    return new Chart(canvas, {
      type: 'line',
      data: {
        labels: this.workspace.months,
        datasets: [
          {
            label: 'This year forecast',
            data: this.selectedProduct.thisYearForecast,
            borderColor: '#0f766e',
            backgroundColor: 'rgba(15, 118, 110, 0.12)',
            borderWidth: 3,
            tension: 0.25,
            fill: true,
            pointRadius: 4,
            pointHoverRadius: 5,
          },
          {
            label: 'Last year forecast',
            data: this.selectedProduct.lastYearForecast,
            borderColor: '#b45309',
            borderDash: [6, 5],
            borderWidth: 2,
            tension: 0.25,
            fill: false,
            pointRadius: 3,
          },
          {
            label: 'Last year actual',
            data: this.selectedProduct.lastYearActual,
            borderColor: '#4b5563',
            backgroundColor: 'rgba(75, 85, 99, 0.08)',
            borderWidth: 2,
            tension: 0.25,
            fill: false,
            pointRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: { display: true, position: 'bottom' },
          tooltip: {
            callbacks: {
              label(context) {
                return `${context.dataset.label}: ${Number(context.parsed.y).toLocaleString()} units`;
              },
            },
          },
        },
        layout: { padding: { bottom: 12 } },
        scales: {
          x: { ticks: { padding: 22 } },
          y: {
            beginAtZero: true,
            ticks: {
              callback(value) {
                return Number(value).toLocaleString();
              },
            },
          },
        },
      },
      plugins: [this.findingMarkerPlugin],
    });
  }

  private pollAiJob(jobId: number): void {
    this.aiPoll?.unsubscribe();
    this.aiPoll = timer(0, 2000)
      .pipe(switchMap(() => this.api.getAiJob(jobId)))
      .subscribe({
        next: (job) => this.applyAiJob(job),
        error: () => {
          this.aiPoll?.unsubscribe();
          this.aiStatusClass = 'failed';
          this.aiStatusText = 'AI analysis status could not be loaded.';
        },
      });
  }

  private applyAiJob(job: AIJob): void {
    this.aiStatusClass = job.status;

    if (job.status === 'failed') {
      this.aiPoll?.unsubscribe();
      this.aiStatusText = job.error_message ?? 'AI analysis failed.';
      return;
    }

    if (job.status === 'completed') {
      this.aiPoll?.unsubscribe();
      this.aiStatusText = 'AI suggestions added to chart markers.';
      this.findings = job.findings ?? {};
      if (this.workspace) {
        this.workspace = { ...this.workspace, findings: this.findings };
      }
      this.closeTooltip();
      this.chart?.update();
      return;
    }

    this.aiStatusText = 'Analyzing forecast...';
  }

  private drawFindingMarkers(chart: Chart<'line'>): void {
    this.markerHitboxes = [];
    if (!this.selectedProduct || !this.workspace) {
      return;
    }

    const xScale = chart.scales['x'];
    if (!xScale) {
      return;
    }

    const findingsByMonth = this.findings[String(this.selectedProduct.dbId)] ?? {};
    const ctx = chart.ctx;

    this.workspace.months.forEach((month, index) => {
      const findings = findingsByMonth[month] ?? [];
      if (!findings.length) {
        return;
      }

      const x = xScale.getPixelForValue(index);
      const y = xScale.top + 16;
      const key = `${this.selectedProduct?.dbId}:${month}`;
      const marker = this.markerStyle(findings);
      this.markerHitboxes.push({ x, y, key, month, findings });

      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.fillStyle = marker.fill;
      ctx.fill();
      ctx.strokeStyle = key === this.openMarkerKey ? '#111827' : '#ffffff';
      ctx.lineWidth = key === this.openMarkerKey ? 2.5 : 2;
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = '800 14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(marker.symbol, x, y - 0.5);
      ctx.restore();
    });
  }

  private toggleTooltip(hitbox: MarkerHitbox): void {
    if (this.openMarkerKey === hitbox.key) {
      this.closeTooltip();
      return;
    }

    this.openMarkerKey = hitbox.key;
    this.tooltipMonth = hitbox.month;
    this.tooltipConsiderations = hitbox.findings.filter((finding) => finding.type === 'consideration');
    this.tooltipRecommendations = hitbox.findings.filter((finding) => finding.type === 'recommendation');
    this.tooltipLeft = hitbox.x + 18;
    this.tooltipTop = hitbox.y + 18;
    this.tooltipOpen = true;
  }

  private closeTooltip(): void {
    this.openMarkerKey = null;
    this.tooltipOpen = false;
  }

  private markerStyle(findings: ForecastFinding[]): { fill: string; symbol: string } {
    const considerationImpact = findings
      .filter((finding) => finding.type === 'consideration')
      .reduce((total, finding) => total + Number(finding.impact || 0), 0);

    if (considerationImpact > 0) {
      return { fill: '#15803d', symbol: '+' };
    }
    if (considerationImpact < 0) {
      return { fill: '#b91c1c', symbol: '-' };
    }
    return { fill: '#64748b', symbol: '*' };
  }
}

import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
  afterRenderEffect,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Chart, Plugin, registerables } from 'chart.js';
import { IgxCardModule } from '@infragistics/igniteui-angular/card';
import { IgxDialogModule } from '@infragistics/igniteui-angular/dialog';
import { IgxButtonModule } from '@infragistics/igniteui-angular/directives';
import { IGridRowEventArgs } from '@infragistics/igniteui-angular/grids/core';
import { IgxGridModule } from '@infragistics/igniteui-angular/grids/grid';
import { IgxIconModule } from '@infragistics/igniteui-angular/icon';
import { IgxInputGroupModule } from '@infragistics/igniteui-angular/input-group';
import { IgxNavbarModule } from '@infragistics/igniteui-angular/navbar';
import { IgxProgressBarModule } from '@infragistics/igniteui-angular/progressbar';
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

interface ForecastRow {
  dbId: number;
  product: string;
  itemCode: string;
  [month: string]: number | string;
}

@Component({
  selector: 'app-root',
  imports: [
    CommonModule,
    FormsModule,
    IgxButtonModule,
    IgxCardModule,
    IgxDialogModule,
    IgxGridModule,
    IgxIconModule,
    IgxInputGroupModule,
    IgxNavbarModule,
    IgxProgressBarModule,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements AfterViewInit, OnDestroy {
  private readonly api = inject(ForecastApi);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly workspaceResource = this.api.workspaceResource;
  private readonly findingMarkerPlugin: Plugin<'line'> = {
    id: 'forecastFindingMarkers',
    afterDraw: (chart) => this.drawFindingMarkers(chart),
  };

  @ViewChild('forecastCanvas') private forecastCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('findingTooltip') private findingTooltip?: ElementRef<HTMLDivElement>;
  @ViewChild('forecastFileInput') private forecastFileInput?: ElementRef<HTMLInputElement>;

  readonly selectedProductId = signal<number | null>(null);
  readonly findingsOverride = signal<ForecastFindingPayload | null>(null);

  readonly selectedUploadFile = signal<File | undefined>(undefined);
  readonly isUploading = signal(false);
  readonly uploadError = signal('');

  readonly isAiModalOpen = signal(false);
  readonly isAiSubmitting = signal(false);
  readonly aiStatusText = signal('');
  readonly aiStatusClass = signal('');
  readonly forecastContext = signal('');
  readonly blindSpots = signal('');

  readonly tooltipOpen = signal(false);
  readonly tooltipLeft = signal(0);
  readonly tooltipTop = signal(0);
  readonly tooltipMonth = signal('');
  readonly tooltipConsiderations = signal<ForecastFinding[]>([]);
  readonly tooltipRecommendations = signal<ForecastFinding[]>([]);
  private readonly openMarkerKey = signal<string | null>(null);

  readonly workspace = computed(() => {
    if (!this.workspaceResource.hasValue()) {
      return undefined;
    }

    return this.workspaceResource.value();
  });

  readonly isLoading = computed(() => this.workspaceResource.isLoading() && !this.workspaceResource.hasValue());
  readonly loadError = computed(() => {
    if (this.workspaceResource.status() !== 'error') {
      return '';
    }

    return 'Forecast data could not be loaded. Make sure the Express API server is running.';
  });

  readonly findings = computed(() => this.findingsOverride() ?? this.workspace()?.findings ?? {});

  readonly selectedProduct = computed(() => {
    const workspace = this.workspace();
    if (!workspace) {
      return undefined;
    }

    const selectedId = this.selectedProductId();
    return workspace.products.find((product) => product.dbId === selectedId) ?? workspace.products[0];
  });

  readonly selectedUploadFileName = computed(() => this.selectedUploadFile()?.name ?? 'No file selected');

  readonly forecastRows = computed(() => {
    const workspace = this.workspace();
    if (!workspace) {
      return [];
    }

    return workspace.products.map((product) => {
      const row: ForecastRow = {
        dbId: product.dbId,
        product: product.label,
        itemCode: product.itemCode,
      };

      for (const month of workspace.months) {
        row[month] = this.forecastValue(product.dbId, month);
      }

      return row;
    });
  });

  private chart?: Chart<'line', number[], string>;
  private aiPoll?: Subscription;
  private markerHitboxes: MarkerHitbox[] = [];

  private readonly chartRenderEffect = afterRenderEffect(() => {
    const workspace = this.workspace();
    const selectedProduct = this.selectedProduct();
    this.findings();
    this.openMarkerKey();

    if (!workspace || !selectedProduct) {
      return;
    }

    this.refreshChart(workspace, selectedProduct);
  });

  ngAfterViewInit(): void {
    const workspace = this.workspace();
    const selectedProduct = this.selectedProduct();
    if (workspace && selectedProduct) {
      this.refreshChart(workspace, selectedProduct);
    }
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
    this.aiPoll?.unsubscribe();
  }

  selectProduct(product: ForecastProduct): void {
    this.selectedProductId.set(product.dbId);
    this.closeTooltip();
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.selectedUploadFile.set(input.files?.[0] ?? undefined);
    this.uploadError.set('');
  }

  uploadForecast(): void {
    const file = this.selectedUploadFile();
    if (!file || this.isUploading()) {
      return;
    }

    this.isUploading.set(true);
    this.uploadError.set('');
    this.api.uploadForecast(file).subscribe({
      next: (workspace) => {
        this.isUploading.set(false);
        this.selectedUploadFile.set(undefined);
        this.findingsOverride.set(null);
        this.clearForecastFileInput();
        this.applyWorkspace(workspace);
      },
      error: (error: HttpErrorResponse) => {
        this.isUploading.set(false);
        this.selectedUploadFile.set(undefined);
        this.clearForecastFileInput();
        const workspace = error.error as ForecastWorkspace | undefined;
        if (workspace?.forecast) {
          this.applyWorkspace(workspace);
          this.uploadError.set(workspace.forecast.error_message ?? 'Forecast CSV could not be applied.');
          return;
        }
        this.uploadError.set('Forecast CSV could not be applied.');
      },
    });
  }

  openAiModal(): void {
    this.isAiModalOpen.set(true);
    this.changeDetector.detectChanges();
    requestAnimationFrame(() => this.changeDetector.detectChanges());
  }

  closeAiModal(): void {
    if (!this.isAiSubmitting()) {
      this.isAiModalOpen.set(false);
      this.changeDetector.detectChanges();
    }
  }

  startAiAnalysis(): void {
    if (this.isAiSubmitting()) {
      return;
    }

    this.isAiSubmitting.set(true);
    this.aiStatusClass.set('running');
    this.aiStatusText.set('Queuing analysis...');
    this.api
      .startAiJob({
        forecast_context: this.forecastContext(),
        blind_spots: this.blindSpots(),
      })
      .subscribe({
        next: (job) => {
          console.log('job', job);
          this.isAiSubmitting.set(false);
          this.isAiModalOpen.set(false);
          this.changeDetector.detectChanges();
          this.aiStatusClass.set(job.status);
          this.aiStatusText.set('Analyzing forecast...');
          this.pollAiJob(job.id);
        },
        error: () => {
          this.isAiSubmitting.set(false);
          this.aiStatusClass.set('failed');
          this.aiStatusText.set('AI analysis could not be started.');
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
    if (!this.tooltipOpen()) {
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
    return this.workspace()?.values_by_product[String(productId)]?.[month] ?? '';
  }

  productForRow(row: ForecastRow): ForecastProduct | undefined {
    return this.workspace()?.products.find((product) => product.dbId === row.dbId);
  }

  selectProductByRow(row: ForecastRow): void {
    const product = this.productForRow(row);
    if (product) {
      this.selectProduct(product);
    }
  }

  onForecastRowClick(event: IGridRowEventArgs): void {
    const data = event.row?.data as ForecastRow | undefined;
    if (data) {
      this.selectProductByRow(data);
    }
  }

  private clearForecastFileInput(): void {
    if (this.forecastFileInput?.nativeElement) {
      this.forecastFileInput.nativeElement.value = '';
    }
  }

  private applyWorkspace(workspace: ForecastWorkspace): void {
    this.workspaceResource.set(workspace);
    this.closeTooltip();
  }

  private refreshChart(workspace: ForecastWorkspace, selectedProduct: ForecastProduct): void {
    if (!this.forecastCanvas) {
      return;
    }

    if (!this.chart) {
      this.chart = this.createChart(workspace, selectedProduct);
      return;
    }

    this.chart.data.labels = workspace.months;
    this.chart.data.datasets[0].data = selectedProduct.thisYearForecast;
    this.chart.data.datasets[1].data = selectedProduct.lastYearForecast;
    this.chart.data.datasets[2].data = selectedProduct.lastYearActual;
    this.chart.update();
  }

  private createChart(workspace: ForecastWorkspace, selectedProduct: ForecastProduct): Chart<'line', number[], string> {
    const canvas = this.forecastCanvas?.nativeElement;
    if (!canvas) {
      throw new Error('Chart cannot be initialized before forecast data is ready.');
    }

    return new Chart(canvas, {
      type: 'line',
      data: {
        labels: workspace.months,
        datasets: [
          {
            label: 'This year forecast',
            data: selectedProduct.thisYearForecast,
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
            data: selectedProduct.lastYearForecast,
            borderColor: '#b45309',
            borderDash: [6, 5],
            borderWidth: 2,
            tension: 0.25,
            fill: false,
            pointRadius: 3,
          },
          {
            label: 'Last year actual',
            data: selectedProduct.lastYearActual,
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
          this.aiStatusClass.set('failed');
          this.aiStatusText.set('AI analysis status could not be loaded.');
        },
      });
  }

  private applyAiJob(job: AIJob): void {
    this.aiStatusClass.set(job.status);

    if (job.status === 'failed') {
      this.aiPoll?.unsubscribe();
      this.aiStatusText.set(job.error_message ?? 'AI analysis failed.');
      return;
    }

    if (job.status === 'completed') {
      this.aiPoll?.unsubscribe();
      this.aiStatusText.set('AI suggestions added to chart markers.');
      this.findingsOverride.set(job.findings ?? {});
      const workspace = this.workspace();
      if (workspace) {
        this.workspaceResource.set({ ...workspace, findings: job.findings ?? {} });
        this.findingsOverride.set(null);
      }
      this.closeTooltip();
      this.chart?.update();
      return;
    }

    this.aiStatusText.set('Analyzing forecast...');
  }

  private drawFindingMarkers(chart: Chart<'line'>): void {
    this.markerHitboxes = [];
    const selectedProduct = this.selectedProduct();
    const workspace = this.workspace();
    if (!selectedProduct || !workspace) {
      return;
    }

    const xScale = chart.scales['x'];
    if (!xScale) {
      return;
    }

    const findingsByMonth = this.findings()[String(selectedProduct.dbId)] ?? {};
    const ctx = chart.ctx;

    workspace.months.forEach((month, index) => {
      const findings = findingsByMonth[month] ?? [];
      if (!findings.length) {
        return;
      }

      const x = xScale.getPixelForValue(index);
      const y = xScale.top + 16;
      const key = `${selectedProduct.dbId}:${month}`;
      const marker = this.markerStyle(findings);
      this.markerHitboxes.push({ x, y, key, month, findings });

      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.fillStyle = marker.fill;
      ctx.fill();
      ctx.strokeStyle = key === this.openMarkerKey() ? '#111827' : '#ffffff';
      ctx.lineWidth = key === this.openMarkerKey() ? 2.5 : 2;
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
    if (this.openMarkerKey() === hitbox.key) {
      this.closeTooltip();
      return;
    }

    this.openMarkerKey.set(hitbox.key);
    this.tooltipMonth.set(hitbox.month);
    this.tooltipConsiderations.set(hitbox.findings.filter((finding) => finding.type === 'consideration'));
    this.tooltipRecommendations.set(hitbox.findings.filter((finding) => finding.type === 'recommendation'));
    this.tooltipLeft.set(hitbox.x + 18);
    this.tooltipTop.set(hitbox.y + 18);
    this.tooltipOpen.set(true);
  }

  private closeTooltip(): void {
    this.openMarkerKey.set(null);
    this.tooltipOpen.set(false);
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

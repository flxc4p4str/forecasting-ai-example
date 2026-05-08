const products = window.forecastProducts || [];
const months = window.forecastMonths || [];
window.forecastFindings = window.forecastFindings || {};

let selectedProduct = products[0] || null;
let markerHitboxes = [];
let openMarkerKey = null;

const title = document.getElementById("selected-product-title");
const description = document.getElementById("selected-product-description");
const brand = document.getElementById("selected-product-brand");
const type = document.getElementById("selected-product-type");
const price = document.getElementById("selected-product-price");
const code = document.getElementById("selected-product-code");
const canvas = document.getElementById("forecast-chart");
const notesBox = document.getElementById("finding-tooltip");
const modal = document.getElementById("ai-modal");
const openModal = document.getElementById("open-ai-modal");
const closeModal = document.getElementById("close-ai-modal");
const cancelModal = document.getElementById("cancel-ai-modal");

const footnotePlugin = {
  id: "forecastFootnotes",
  afterDraw(chart) {
    markerHitboxes = [];
    if (!selectedProduct) return;

    const xScale = chart.scales.x;
    const findingsByMonth = window.forecastFindings[String(selectedProduct.dbId)] || {};
    const ctx = chart.ctx;

    months.forEach((month, index) => {
      const findings = findingsByMonth[month] || [];
      if (!findings.length) return;

      const x = xScale.getPixelForValue(index);
      const y = xScale.top + 16;
      const key = `${selectedProduct.dbId}:${month}`;
      const marker = markerStyle(findings);
      markerHitboxes.push({ x, y, key, month, findings });

      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.fillStyle = marker.fill;
      ctx.fill();
      ctx.strokeStyle = key === openMarkerKey ? "#17211f" : "#ffffff";
      ctx.lineWidth = key === openMarkerKey ? 2.5 : 2;
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.font = "800 14px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(marker.symbol, x, y - 0.5);
      ctx.restore();
    });
  },
};

const chart = new Chart(canvas, {
  type: "line",
  data: {
    labels: months,
    datasets: [
      {
        label: "This year forecast",
        data: selectedProduct ? selectedProduct.thisYearForecast : [],
        borderColor: "#126a5a",
        backgroundColor: "rgba(18, 106, 90, 0.12)",
        borderWidth: 3,
        tension: 0.25,
        fill: true,
        pointRadius: 4,
        pointHoverRadius: 5,
      },
      {
        label: "Last year forecast",
        data: selectedProduct ? selectedProduct.lastYearForecast : [],
        borderColor: "#9b6b1f",
        borderDash: [6, 5],
        borderWidth: 2,
        tension: 0.25,
        fill: false,
        pointRadius: 3,
      },
      {
        label: "Last year actual",
        data: selectedProduct ? selectedProduct.lastYearActual : [],
        borderColor: "#53606a",
        backgroundColor: "rgba(83, 96, 106, 0.08)",
        borderWidth: 2,
        tension: 0.25,
        fill: false,
        pointRadius: 3,
      },
    ],
  },
  options: {
    responsive: true,
    interaction: { intersect: false, mode: "index" },
    plugins: {
      legend: { display: true, position: "bottom" },
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
  plugins: [footnotePlugin],
});

function selectProduct(productId) {
  selectedProduct = products.find((product) => String(product.dbId) === String(productId)) || products[0];
  if (!selectedProduct) return;

  title.textContent = selectedProduct.label;
  description.textContent = selectedProduct.profile.description;
  brand.textContent = selectedProduct.profile.brand;
  type.textContent = selectedProduct.profile.type;
  price.textContent = selectedProduct.profile.retailPrice;
  code.textContent = selectedProduct.profile.itemCode;

  chart.data.datasets[0].data = selectedProduct.thisYearForecast;
  chart.data.datasets[1].data = selectedProduct.lastYearForecast;
  chart.data.datasets[2].data = selectedProduct.lastYearActual;
  closeNotes();
  chart.update();

  document.querySelectorAll(".product-row").forEach((row) => {
    row.classList.toggle("selected", row.dataset.productId === String(selectedProduct.dbId));
  });
}

function toggleNotes(hitbox) {
  if (openMarkerKey === hitbox.key) {
    closeNotes();
    chart.update();
    return;
  }

  openMarkerKey = hitbox.key;
  renderNotes(hitbox);
  chart.update();
}

function renderNotes(hitbox) {
  const considerations = hitbox.findings.filter((finding) => finding.type === "consideration");
  const recommendations = hitbox.findings.filter((finding) => finding.type === "recommendation");
  notesBox.innerHTML = `
    <div class="tooltip-heading">${escapeHtml(hitbox.month)}</div>
    ${formatFindingSection("Considerations", considerations)}
    ${formatFindingSection("Recommendations", recommendations)}
  `;
  notesBox.hidden = false;
  notesBox.style.left = `${hitbox.x + 18}px`;
  notesBox.style.top = `${hitbox.y + 18}px`;
}

function closeNotes() {
  openMarkerKey = null;
  notesBox.hidden = true;
}

function formatFinding(finding) {
  const impact = Number(finding.impact);
  const sign = impact > 0 ? "+" : "";
  return `<li><strong>${impactEmoji(impact)} ${sign}${impact}</strong><p>${escapeHtml(finding.description)}</p></li>`;
}

function markerStyle(findings) {
  const considerationImpact = findings
    .filter((finding) => finding.type === "consideration")
    .reduce((total, finding) => total + Number(finding.impact || 0), 0);

  if (considerationImpact > 0) {
    return { fill: "#178f57", symbol: "+" };
  }
  if (considerationImpact < 0) {
    return { fill: "#c2413f", symbol: "-" };
  }
  return { fill: "#6a756f", symbol: "•" };
}

function formatFindingSection(title, findings) {
  if (!findings.length) return "";
  return `
    <section>
      <h4>${escapeHtml(title)}</h4>
      <ul>${findings.map(formatFinding).join("")}</ul>
    </section>
  `;
}

function impactEmoji(impact) {
  if (impact <= -3) return "📉";
  if (impact < 0) return "↘️";
  if (impact === 0) return "⚪";
  if (impact < 3) return "↗️";
  return "📈";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

canvas.addEventListener("click", (event) => {
  const bounds = canvas.getBoundingClientRect();
  const x = event.clientX - bounds.left;
  const y = event.clientY - bounds.top;
  const nearby = markerHitboxes.find((hitbox) => Math.hypot(hitbox.x - x, hitbox.y - y) <= 22);

  if (nearby) {
    toggleNotes(nearby);
  } else {
    closeNotes();
    chart.update();
  }
});

document.addEventListener("click", (event) => {
  if (event.target === canvas || notesBox.contains(event.target)) return;
  if (!notesBox.hidden) {
    closeNotes();
    chart.update();
  }
});

document.querySelectorAll("[data-select-product]").forEach((button) => {
  button.addEventListener("click", () => selectProduct(button.dataset.selectProduct));
});

window.mergeForecastFindings = function mergeForecastFindings(nextFindings) {
  window.forecastFindings = nextFindings || {};
  closeNotes();
  chart.update();
};

openModal.addEventListener("click", () => modal.showModal());
closeModal.addEventListener("click", () => modal.close());
cancelModal.addEventListener("click", () => modal.close());

selectProduct(selectedProduct && selectedProduct.dbId);

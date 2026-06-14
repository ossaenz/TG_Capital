function renderWashSales() {
  const flags = detectWashSales();
  document.getElementById('washCount').textContent = flags.length ? `${flags.length} potential violations` : 'No flags';
  const tbody = document.querySelector('#washTable tbody');
  if (flags.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No wash sale flags detected based on available data.</td></tr>';
    return;
  }
  tbody.innerHTML = flags.map(f => {
    const riskColor = f.risk === 'HIGH' ? 'var(--red)' : f.risk === 'MEDIUM' ? 'var(--amber)' : 'var(--text2)';
    return `<tr>
      <td><span style="font-family:var(--mono);font-weight:700">${f.symbol}</span></td>
      <td>${f.lossDate}</td>
      <td><span class="pos r">${fmt$(f.lossAmount)}</span></td>
      <td>${f.repDate}</td>
      <td class="r">${f.daysApart}d</td>
      <td style="color:var(--text1)">${f.repAction}</td>
      <td><span style="color:${riskColor};font-family:var(--mono);font-weight:700">${f.risk}</span></td>
    </tr>`;
  }).join('');
}

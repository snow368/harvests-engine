// @ts-nocheck
import fs from 'fs';

const xmlHeader = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel">
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal">
   <Font ss:FontName="Microsoft YaHei" ss:Size="10"/>
  </Style>
  <Style ss:ID="header">
   <Font ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#333333" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="needles">
   <Interior ss:Color="#E8F5E9" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="machines">
   <Interior ss:Color="#E3F2FD" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="ink">
   <Interior ss:Color="#FFF3E0" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="aftercare">
   <Interior ss:Color="#F3E5F5" ss:Pattern="Solid"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="Brand Verification">
  <Table>
   <Column ss:Width="180"/>
   <Column ss:Width="140"/>
   <Column ss:Width="320"/>
   <Column ss:Width="80"/>
   <Column ss:Width="80"/>
   <Column ss:Width="100"/>
   <Column ss:Width="120"/>
   <Column ss:Width="120"/>
  </Table>
  <Row ss:StyleID="header">
   <Cell><Data ss:Type="String">Category</Data></Cell>
   <Cell><Data ss:Type="String">Brand Handle</Data></Cell>
   <Cell><Data ss:Type="String">IG URL</Data></Cell>
   <Cell><Data ss:Type="String">Status ✅/❌</Data></Cell>
   <Cell><Data ss:Type="String">Official IG?</Data></Cell>
   <Cell><Data ss:Type="String">Website</Data></Cell>
   <Cell><Data ss:Type="String">Notes</Data></Cell>
   <Cell><Data ss:Type="String">Priority (H/M/L)</Data></Cell>
  </Row>`;

const brands = [
  { cat: 'needles_cartridges', items: ['kwadron','kwadronofficial','neotat','neotat_official','mickeysharps','mickey_sharps','tatsoul','tatsoul_official','lotustattoo_supply'] },
  { cat: 'machines_pens', items: ['fkirons','fkironsofficial','bishoprotary','stigmarotary','stigmatattoosupply','workhorseirons','eikondevice','eikontattoo','dragonhawktattoo','dragonhawkofficial','dragonhawk_global','masttattoo','mast_tattoo_supply','masttattoosupply','cheyennetattooequipment','zeustattoo','zeus_tattoo_machines','pentattoo','rotarytattoo'] },
  { cat: 'ink', items: ['worldfamousink','intenzetattooink','intenze_ink','eternalink','eternal_tattoo_ink','dynamiccolortattoo','radiantcolorsink','radiant_colors_ink','kurosumi_ink','kurosumi_official','killer_ink','viciousink','inkjecta','inkjecta_tattoo','solidinktattoo','wickedink'] },
  { cat: 'aftercare', items: ['hustlebutter','hustle_butter','tattoogoo','tattoo_goo','madrabbit','mad_rabbit_tattoo','recoverytattoo','tattoo_recovery','drmpickle','dr_pickle','secondskin','second_skin_tattoo','tattoo_healing','healing_tattoo'] },
];

let rows = '';
for (const b of brands) {
  const style = b.cat === 'needles_cartridges' ? 'needles' : b.cat === 'machines_pens' ? 'machines' : b.cat === 'ink' ? 'ink' : 'aftercare';
  for (const h of b.items) {
    rows += `  <Row ss:StyleID="${style}">
   <Cell><Data ss:Type="String">${b.cat}</Data></Cell>
   <Cell><Data ss:Type="String">${h}</Data></Cell>
   <Cell><Data ss:Type="String">https://www.instagram.com/${h}/</Data></Cell>
   <Cell><Data ss:Type="String"></Data></Cell>
   <Cell><Data ss:Type="String"></Data></Cell>
   <Cell><Data ss:Type="String"></Data></Cell>
   <Cell><Data ss:Type="String"></Data></Cell>
   <Cell><Data ss:Type="String"></Data></Cell>
  </Row>\n`;
  }
}

const xmlFooter = ` </Table>
 </Worksheet>
</Workbook>`;

fs.writeFileSync('data/brand_verification_table.xml', xmlHeader + rows + xmlFooter, 'utf8');
console.log('Saved: data/brand_verification_table.xml');
console.log('Open in Excel — it renders as a proper table.');

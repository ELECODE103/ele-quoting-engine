// Single source of brand facts for the client. Edit shared/brand.json, not this file.
import brand from '../../shared/brand.json';

export default brand;

export const PROCESS_LABELS = {
  cnc: 'CNC Machining',
  routing: 'CNC Routing',
  '3d-printing': '3D Printing',
  sheetmetal: 'Sheet Metal',
};

export const PROCESS_BLURBS = {
  cnc: 'Milling and turning. Delrin, UHMW, nylon, PEEK, 6061 and more.',
  routing: 'Flat and plate parts nested from sheet on a 59" × 96" router.',
  '3d-printing': 'FDM and SLA. Prototypes, fixtures, low-volume parts.',
};

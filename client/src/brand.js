// Single source of brand facts for the client. Edit shared/brand.json, not this file.
import brand from '../../shared/brand.json';
import { when } from './facts';

export default brand;

export const PROCESS_LABELS = {
  cnc: 'CNC Machining',
  routing: 'CNC Routing',
  '3d-printing': '3D Printing',
  sheetmetal: 'Sheet Metal',
};

export const PROCESS_BLURBS = {
  cnc: when('turning', 'Milling and turning.', 'Milling.') + ' Delrin, UHMW, nylon, PEEK, 6061 and more.',
  routing: 'Flat parts cut from sheet, with pockets and counterbores. Up to 59" × 96".',
  '3d-printing': 'FDM and SLA. Prototypes, fixtures, low-volume parts.',
};

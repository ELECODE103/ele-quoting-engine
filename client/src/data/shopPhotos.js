// The 14 shop photos. `alt` says only what anyone can see in the picture.
// The caption (material, thickness, quantity) is an owner-dependent claim, so it
// lives in shared/shop-facts.json under `photo-<id>` and shows only when the
// owner has confirmed the photo is his own direct work and the caption is right.
import { fact } from '../facts';

const P = {
  'tray-stack-edge': 'Stack of white plastic plates with chamfered corners on a shop bench',
  'tray-stack-router': 'White plastic tray with a machined pocket and slots, lying on a router table',
  'acetal-clamps': 'Five small black machined plastic blocks on a granite plate',
  'fourth-axis': 'White plastic part held between centers on a rotary axis in a CNC mill',
  'disc-stacks': 'Two stacks of white notched plastic discs beside the sheet they were cut from',
  'uhmw-rack': 'White plastic bar with a row of machined teeth, on a cutting mat',
  'brackets-inspection': 'Black machined plastic saddle brackets on a granite plate beside a height gage',
  'dish-part': 'Round black part with a machined white plastic insert, on a granite plate',
  'cups-lot': 'Eleven white machined plastic cups on a cutting mat',
  'disc-router-bed': 'White notched plastic disc held over the sheet it was cut from',
  'hdpe-plate': 'White plastic plate with a pattern of drilled holes',
  'disc-hand': 'White notched plastic disc with six holes, held up in the shop',
  'fdm-print': 'Large white 3D print on the build plate of an enclosed printer',
  'phenolic-prototype': 'Clear printed housing and three small machined plates on a cutting mat',
};

export function shopPhoto(id) {
  if (!P[id]) throw new Error(`Unknown shop photo "${id}"`);
  return { id, src: `/photos/${id}.jpg`, alt: P[id], cap: fact(`photo-${id}`) || '' };
}

export const PHOTO_IDS = Object.keys(P);

export type EquipKind = 'frag' | 'molotov' | 'smoke';

export interface EquipConfig {
  id: EquipKind;
  name: string;
  description: string;
  color: number;
}

export const EQUIPMENT: Record<EquipKind, EquipConfig> = {
  frag: {
    id: 'frag', name: 'Frag Grenade',
    description: 'Radial damage + knockback impulse.',
    color: 0x9aa84a,
  },
  molotov: {
    id: 'molotov', name: 'Molotov',
    description: 'Fire zone on impact; ignites blood pools.',
    color: 0xe07a2a,
  },
  smoke: {
    id: 'smoke', name: 'Smoke',
    description: 'Blocks line of sight.',
    color: 0x9aa4ae,
  },
};

import { z } from 'zod';

export const Vec3Schema = z.tuple([z.number().int(), z.number().int(), z.number().int()]);
export const Vec2Schema = z.tuple([z.number().int(), z.number().int()]);
export const RotationSchema = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);
export const MirrorSchema = z.enum(['none', 'x', 'z']);
export const WorldSchema = z
  .string()
  .describe('overworld (default), nether, end, a minecraft:<dimension> id, or a Bukkit world folder name');

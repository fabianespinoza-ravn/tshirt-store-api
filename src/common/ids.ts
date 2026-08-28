import { v7 as uuidv7 } from 'uuid';

// UUIDv7 generado por la aplicación, nunca @default de SQL (ver el ERD); el orden importa porque la portada del producto es la primera imagen por id ascendente, y eso se rompería con UUIDv4.
export const newId = (): string => uuidv7();

// Convierte "15m" o "7d" a milisegundos: las TTL viven en el entorno como cadena porque @nestjs/jwt las consume así, pero expires_at es una columna de fecha y necesita el número.
export function parseDuration(value: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(value.trim());

  if (!match) {
    throw new Error(
      `Duración inválida: "${value}". Formato esperado: 30s, 15m, 12h o 7d.`,
    );
  }

  const amount = Number(match[1]);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';
  const factor = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];

  return amount * factor;
}

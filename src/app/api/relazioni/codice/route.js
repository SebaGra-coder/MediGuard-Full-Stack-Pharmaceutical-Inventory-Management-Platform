import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '@/lib/prisma';

export async function POST(request) {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get('session_token')?.value;

    if (!token) {
      return NextResponse.json(
        { message: 'Non autenticato' },
        { status: 401 }
      );
    }

    const secret = process.env.JWT_SECRET;

    if (!secret) {
      console.error('JWT_SECRET non configurato');
      return NextResponse.json(
        { message: 'Errore di configurazione del server' },
        { status: 500 }
      );
    }

    let decoded;

    try {
      decoded = jwt.verify(token, secret);
    } catch {
      return NextResponse.json(
        { message: 'Token non valido o scaduto' },
        { status: 401 }
      );
    }

    if (!decoded || typeof decoded !== 'object' || !decoded.id) {
      return NextResponse.json(
        { message: 'Token non valido' },
        { status: 401 }
      );
    }

    const utente = await prisma.utente.findUnique({
      where: { id_utente: decoded.id },
      select: { id_utente: true }
    });

    if (!utente) {
      return NextResponse.json(
        { message: 'Utente non trovato' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const targetRole = body.targetRole ?? 'ASSISTITO';

    if (!['ASSISTITO', 'CAREGIVER'].includes(targetRole)) {
      return NextResponse.json(
        { message: 'Ruolo destinatario non valido' },
        { status: 400 }
      );
    }

    const data_scadenza = new Date();
    data_scadenza.setHours(data_scadenza.getHours() + 24);

    // In caso di collisione, genera un nuovo codice.
    for (let tentativo = 0; tentativo < 5; tentativo++) {
      const codeString = randomBytes(4)
        .toString('hex')
        .slice(0, 6)
        .toUpperCase();

      try {
        const nuovoCodice = await prisma.codice_abbinamento.create({
          data: {
            codeString,
            id_creatore: utente.id_utente,
            ruolo_target: targetRole,
            data_scadenza
          }
        });

        return NextResponse.json(
          { code: nuovoCodice.codeString },
          { status: 200 }
        );
      } catch (error) {
        if (error.code !== 'P2002') {
          throw error;
        }
      }
    }

    return NextResponse.json(
      { message: 'Impossibile generare un codice univoco. Riprova.' },
      { status: 503 }
    );

  } catch (error) {
    console.error('Errore API generate code:', error);

    return NextResponse.json(
      { message: 'Errore server' },
      { status: 500 }
    );
  }
}
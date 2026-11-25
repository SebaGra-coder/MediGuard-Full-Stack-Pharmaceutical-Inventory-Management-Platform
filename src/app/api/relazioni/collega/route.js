import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
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

    const currentUser = await prisma.utente.findUnique({
      where: { id_utente: decoded.id },
      select: { id_utente: true }
    });

    if (!currentUser) {
      return NextResponse.json(
        { message: 'Utente non trovato' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const code = typeof body.code === 'string'
      ? body.code.trim().toUpperCase()
      : '';

    if (!code) {
      return NextResponse.json(
        { message: 'Codice mancante' },
        { status: 400 }
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      const now = new Date();

      // 1. Recupera il codice.
      const codiceRecord = await tx.codice_abbinamento.findUnique({
        where: { codeString: code }
      });

      if (!codiceRecord) {
        return {
          status: 404,
          message: 'Codice non valido o inesistente'
        };
      }

      // 2. Controlla la scadenza.
      if (now > codiceRecord.data_scadenza) {
        await tx.codice_abbinamento.deleteMany({
          where: { codeString: code }
        });

        return {
          status: 400,
          message: 'Codice scaduto'
        };
      }

      // 3. Controlla che il codice non venga usato dal creatore.
      if (codiceRecord.id_creatore === currentUser.id_utente) {
        return {
          status: 400,
          message: 'Non puoi usare il tuo stesso codice'
        };
      }

      // 4. Valida il ruolo del destinatario.
      if (!['ASSISTITO', 'CAREGIVER'].includes(codiceRecord.ruolo_target)) {
        return {
          status: 400,
          message: 'Ruolo associato al codice non valido'
        };
      }

      // 5. Determina caregiver e assistito.
      let id_caregiver;
      let id_assistito;

      if (codiceRecord.ruolo_target === 'ASSISTITO') {
        id_caregiver = codiceRecord.id_creatore;
        id_assistito = currentUser.id_utente;
      } else {
        id_caregiver = currentUser.id_utente;
        id_assistito = codiceRecord.id_creatore;
      }

      // 6. Verifica se esiste già la relazione.
      const existingRel = await tx.relazione.findFirst({
        where: {
          id_caregiver,
          id_assistito
        },
        select: {
          id_relazione: true
        }
      });

      if (existingRel) {
        await tx.codice_abbinamento.deleteMany({
          where: { codeString: code }
        });

        return {
          status: 409,
          message: 'Relazione già esistente'
        };
      }

      // 7. Consuma il codice in modo atomico.
      // Solo una richiesta può ottenere count === 1.
      const codiceConsumato = await tx.codice_abbinamento.deleteMany({
        where: {
          codeString: code,
          data_scadenza: { gt: now }
        }
      });

      if (codiceConsumato.count !== 1) {
        return {
          status: 409,
          message: 'Codice già utilizzato o non più valido'
        };
      }

      // 8. Crea la relazione.
      await tx.relazione.create({
        data: {
          id_caregiver,
          id_assistito,
          permessi_armadietto: 'ADMIN',
          permessi_piano: 'ADMIN'
        }
      });

      return {
        status: 200,
        message: 'Collegamento avvenuto con successo!'
      };
    });

    return NextResponse.json(
      { message: result.message },
      { status: result.status }
    );

  } catch (error) {
    console.error('Errore API collega:', error);

    return NextResponse.json(
      { message: 'Errore server' },
      { status: 500 }
    );
  }
}
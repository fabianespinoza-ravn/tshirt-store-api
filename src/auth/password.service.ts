import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

// Argon2id with the library's default values (the ones OWASP recommends); no
// parameters are stored separately because the hash itself carries its
// variant, version and cost, so raising them later doesn't invalidate hashes
// already written.
@Injectable()
export class PasswordService {
  // Hash to compare against when the user doesn't exist: without this, a
  // nonexistent account would respond faster than a real one, and the timing
  // would give away which ones are registered.
  private readonly decoy = hash('password-that-belongs-to-nobody');

  async hash(plain: string): Promise<string> {
    return hash(plain);
  }

  async verify(digest: string, plain: string): Promise<boolean> {
    try {
      return await verify(digest, plain);
    } catch {
      // A corrupt hash or one from another algorithm isn't a domain
      // exception: it's just a credential that doesn't work.
      return false;
    }
  }

  // Burns the same amount of time as a real verification, against the decoy
  // hash, so timing doesn't give away that the user doesn't exist.
  async burnTime(plain: string): Promise<false> {
    await this.verify(await this.decoy, plain);
    return false;
  }
}

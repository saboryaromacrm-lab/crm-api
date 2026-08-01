import { Body, Controller, Get, Inject, Injectable, Module, Post } from '@nestjs/common';
import { IsIn, IsString } from 'class-validator';
import { DRIZZLE, Database } from '../db/drizzle';
import { usuarios } from '../db/schema';

class CreateUsuarioDto {
  @IsString() nombre!: string;
  @IsIn(['admin', 'fraccionador', 'vendedor']) rol!: 'admin' | 'fraccionador' | 'vendedor';
}

@Injectable()
export class UsuariosService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  list() { return this.db.select().from(usuarios).orderBy(usuarios.id); }

  async create(dto: CreateUsuarioDto) {
    const [u] = await this.db.insert(usuarios).values({ nombre: dto.nombre.trim(), rol: dto.rol }).returning();
    return u;
  }
}

@Controller('usuarios')
export class UsuariosController {
  constructor(private readonly svc: UsuariosService) {}
  @Get() list() { return this.svc.list(); }
  @Post() create(@Body() dto: CreateUsuarioDto) { return this.svc.create(dto); }
}

@Module({
  controllers: [UsuariosController],
  providers: [UsuariosService],
})
export class UsuariosModule {}

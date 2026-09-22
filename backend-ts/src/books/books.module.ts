import { Module } from '@nestjs/common';

import { BooksController } from './books.controller';
import { ChaptersController } from './chapters.controller';
import { LibraryController } from './library.controller';
import { BooksService } from './books.service';
import { RagModule } from '../rag/rag.module';

/** 书籍/章节/设定库 —— 对应 routers/books.py 全文（829 行）。RagModule 供章节保存时向量化。 */
@Module({
  imports: [RagModule],
  controllers: [BooksController, ChaptersController, LibraryController],
  providers: [BooksService],
  exports: [BooksService],
})
export class BooksModule {}

using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace radar.forecast.data.Migrations
{
    /// <inheritdoc />
    public partial class Models : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "DbModel",
                columns: table => new
                {
                    OID = table.Column<Guid>(type: "TEXT", nullable: false),
                    Name = table.Column<string>(type: "TEXT", maxLength: 255, nullable: false),
                    Note = table.Column<string>(type: "TEXT", maxLength: 4000, nullable: true),
                    Bundle = table.Column<string>(type: "TEXT", maxLength: 1024, nullable: false),
                    Kind = table.Column<string>(type: "TEXT", maxLength: 16, nullable: false),
                    Case = table.Column<string>(type: "TEXT", maxLength: 16, nullable: false),
                    Label = table.Column<string>(type: "TEXT", maxLength: 128, nullable: true),
                    Members = table.Column<int>(type: "INTEGER", nullable: false),
                    Seeds = table.Column<string>(type: "TEXT", maxLength: 128, nullable: true),
                    FromDiplom = table.Column<bool>(type: "INTEGER", nullable: false),
                    Created = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DbModel", x => x.OID);
                });

            migrationBuilder.CreateTable(
                name: "DbRunModel",
                columns: table => new
                {
                    OID = table.Column<Guid>(type: "TEXT", nullable: false),
                    Run = table.Column<Guid>(type: "TEXT", nullable: true),
                    Model = table.Column<Guid>(type: "TEXT", nullable: true),
                    Position = table.Column<int>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DbRunModel", x => x.OID);
                    table.ForeignKey(
                        name: "FK_DbRunModel_DbModel_Model",
                        column: x => x.Model,
                        principalTable: "DbModel",
                        principalColumn: "OID",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_DbRunModel_DbRun_Run",
                        column: x => x.Run,
                        principalTable: "DbRun",
                        principalColumn: "OID",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_DbRunModel_Model",
                table: "DbRunModel",
                column: "Model");

            migrationBuilder.CreateIndex(
                name: "IX_DbRunModel_Run",
                table: "DbRunModel",
                column: "Run");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "DbRunModel");

            migrationBuilder.DropTable(
                name: "DbModel");
        }
    }
}

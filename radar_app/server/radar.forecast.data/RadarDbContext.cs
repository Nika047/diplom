using radar.forecast.data.App;
using radar.forecast.data.Security;

using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

namespace radar.forecast.data;

// контекст SQLite приложения: учётные записи (ASP.NET Identity), загруженные файлы, модели, запуски, сценарии
public class RadarDbContext(DbContextOptions<RadarDbContext> options) : IdentityDbContext<DbAccount, IdentityRole<Guid>, Guid>(options)
{
    public DbSet<DbRefreshToken> RefreshTokens => Set<DbRefreshToken>();
    public DbSet<DbSourceFile> SourceFiles => Set<DbSourceFile>();
    public DbSet<DbRun> Runs => Set<DbRun>();
    public DbSet<DbModel> Models => Set<DbModel>();
    public DbSet<DbRunModel> RunModels => Set<DbRunModel>();
    public DbSet<DbScenario> Scenarios => Set<DbScenario>();
    public DbSet<DbScenarioModel> ScenarioModels => Set<DbScenarioModel>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        base.OnModelCreating(b);

        b.Entity<DbRefreshToken>(e =>
        {
            e.ToTable("DbRefreshToken");
            e.HasKey(x => x.OID);
            e.Property(x => x.Token).HasMaxLength(128);
            e.HasIndex(x => x.Token);

            // внешний ключ теневой, как в ggnp.ofd
            e.Property<Guid?>("OwnerOID").HasColumnName("Owner");
            e.HasOne(x => x.Owner)
                .WithMany(a => a.Tokens)
                .HasForeignKey("OwnerOID")
                .OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<DbSourceFile>(e =>
        {
            e.ToTable("DbSourceFile");
            e.HasKey(x => x.OID);
            e.Property(x => x.FileName).HasMaxLength(255);
            e.Property(x => x.Kind).HasConversion<string>().HasMaxLength(16);
            e.HasIndex(x => x.Created);
        });

        b.Entity<DbRun>(e =>
        {
            e.ToTable("DbRun");
            e.HasKey(x => x.OID);
            e.Property(x => x.Mode).HasConversion<string>().HasMaxLength(16);
            e.Property(x => x.Case).HasConversion<string>().HasMaxLength(16);
            e.Property(x => x.Model).HasMaxLength(128);
            e.HasIndex(x => x.Created);

            e.Property<Guid?>("SourceFileOID").HasColumnName("SourceFile");
            e.HasOne(x => x.SourceFile)
                .WithMany()
                .HasForeignKey("SourceFileOID")
                .OnDelete(DeleteBehavior.Restrict);
            e.HasIndex("SourceFileOID");
            e.Property(x => x.TrackRun).HasMaxLength(64);
            e.Property(x => x.TrackId).HasMaxLength(255);
            e.Property(x => x.ScenarioName).HasMaxLength(200);
        });

        b.Entity<DbScenario>(e =>
        {
            e.ToTable("DbScenario");
            e.HasKey(x => x.OID);
            e.Property(x => x.Name).HasMaxLength(200);
            e.Property(x => x.Note).HasMaxLength(4000);
            e.Property(x => x.FlightSource).HasConversion<string>().HasMaxLength(16);
            e.Property(x => x.LogName).HasMaxLength(255);
            e.Property(x => x.TrackRun).HasMaxLength(64);
            e.Property(x => x.TrackId).HasMaxLength(255);
            e.Property(x => x.Mode).HasConversion<string>().HasMaxLength(16);
            e.Property(x => x.Basemap).HasMaxLength(16);
            e.Property(x => x.Horizons).HasMaxLength(64);
            e.Property(x => x.Layers).HasMaxLength(128);
            e.HasIndex(x => x.Name).IsUnique();

            // загруженный файл сценария не удаляется (SourceFilesController.Delete)
            e.Property<Guid?>("SourceFileOID").HasColumnName("SourceFile");
            e.HasOne(x => x.SourceFile)
                .WithMany()
                .HasForeignKey("SourceFileOID")
                .OnDelete(DeleteBehavior.Restrict);
            e.HasIndex("SourceFileOID");
        });

        b.Entity<DbScenarioModel>(e =>
        {
            e.ToTable("DbScenarioModel");
            e.HasKey(x => x.OID);

            e.Property<Guid?>("ScenarioOID").HasColumnName("Scenario");
            e.HasOne(x => x.Scenario)
                .WithMany(s => s.ScenarioModels)
                .HasForeignKey("ScenarioOID")
                .OnDelete(DeleteBehavior.Cascade);
            e.HasIndex("ScenarioOID");

            // модель сценария не удаляется (ModelsController.Delete)
            e.Property<Guid?>("ModelOID").HasColumnName("Model");
            e.HasOne(x => x.Model)
                .WithMany()
                .HasForeignKey("ModelOID")
                .OnDelete(DeleteBehavior.Restrict);
            e.HasIndex("ModelOID");
        });

        b.Entity<DbModel>(e =>
        {
            e.ToTable("DbModel");
            e.HasKey(x => x.OID);
            e.Property(x => x.Name).HasMaxLength(255);
            e.Property(x => x.Note).HasMaxLength(4000);
            e.Property(x => x.Bundle).HasMaxLength(1024);
            e.Property(x => x.Kind).HasConversion<string>().HasMaxLength(16);
            e.Property(x => x.Case).HasConversion<string>().HasMaxLength(16);
            e.Property(x => x.Label).HasMaxLength(128);
            e.Property(x => x.Seeds).HasMaxLength(128);
            e.Property(x => x.Run).HasMaxLength(64);
        });

        b.Entity<DbRunModel>(e =>
        {
            e.ToTable("DbRunModel");
            e.HasKey(x => x.OID);

            e.Property<Guid?>("RunOID").HasColumnName("Run");
            e.HasOne(x => x.Run)
                .WithMany(r => r.RunModels)
                .HasForeignKey("RunOID")
                .OnDelete(DeleteBehavior.Cascade);
            e.HasIndex("RunOID");

            // модель с запусками не удаляется (ModelsController.Delete)
            e.Property<Guid?>("ModelOID").HasColumnName("Model");
            e.HasOne(x => x.Model)
                .WithMany()
                .HasForeignKey("ModelOID")
                .OnDelete(DeleteBehavior.Restrict);
            e.HasIndex("ModelOID");
        });
    }

    // относительный путь файла базы считается от папки веб-проекта, а не от текущей папки процесса
    public static string ResolveConnection(string connection, string root)
    {
        SqliteConnectionStringBuilder builder = new(connection);

        if (!Path.IsPathRooted(builder.DataSource))
            builder.DataSource = Path.GetFullPath(Path.Combine(root, builder.DataSource));

        Directory.CreateDirectory(Path.GetDirectoryName(builder.DataSource)!);

        return builder.ToString();
    }
}

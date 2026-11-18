namespace radar.forecast.data;

// общий предок собственных сущностей: ключ OID, как в ggnp.ofd
public abstract class DbAbstractDataObject
{
    public Guid OID { get; set; } = Guid.NewGuid();
}

using System.Collections;
using AstervoidsWeb.Models;

namespace AstervoidsWeb.Services;

internal static class SyncDataCloner
{
    public static SessionObject CloneObject(SessionObject obj)
        => new()
        {
            Id = obj.Id,
            Handle = obj.Handle,
            SessionId = obj.SessionId,
            CreatorMemberId = obj.CreatorMemberId,
            OwnerMemberId = obj.OwnerMemberId,
            Scope = obj.Scope,
            Data = CloneDictionary(obj.Data),
            SchemaId = obj.SchemaId,
            Version = obj.Version,
            ValidAt = obj.ValidAt,
            CreatedAt = obj.CreatedAt,
            UpdatedAt = obj.UpdatedAt
        };

    public static Dictionary<string, object?> CloneDictionary(
        IDictionary<string, object?> source)
        => source.ToDictionary(
            pair => pair.Key,
            pair => CloneValue(pair.Value));

    public static object? CloneValue(object? value)
    {
        return value switch
        {
            null => null,
            string => value,
            ValueType => value,
            byte[] bytes => bytes.ToArray(),
            IDictionary<string, object?> dictionary =>
                CloneDictionary(dictionary),
            IDictionary<object, object?> dictionary =>
                dictionary.ToDictionary(
                    pair => pair.Key,
                    pair => CloneValue(pair.Value)),
            Array array => CloneArray(array),
            IList list => list.Cast<object?>().Select(CloneValue).ToList(),
            _ => value
        };
    }

    private static Array CloneArray(Array source)
    {
        if (source.Rank != 1)
            return (Array)source.Clone();

        var elementType = source.GetType().GetElementType() ?? typeof(object);
        var clone = Array.CreateInstance(elementType, source.Length);
        for (var index = 0; index < source.Length; index++)
            clone.SetValue(CloneValue(source.GetValue(index)), index);
        return clone;
    }
}

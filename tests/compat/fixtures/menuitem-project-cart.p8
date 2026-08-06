pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
tick=0
called=0
ok=true
function callback()
 called+=1
 return true
end
function _init()
 ok=type(menuitem)=="function"
 menuitem(1,"first",callback)
 menuitem(2,"1234567890123456",callback)
 menuitem(0xff05,"filtered",callback)
 menuitem(1,"replacement",function() called+=10 end)
 menuitem(1)
 menuitem(2,nil,callback)
 menuitem(5,"filtered")
end
function _update()
 tick+=1
 if tick%30==0 then
  menuitem(3,"tick "..tick,function() called+=100 end)
 end
 if tick%30==15 then menuitem(3) end
 if called!=0 then error("menu callback invoked without pause-menu ui") end
end
function _draw()
 cls(ok and 3 or 8)
 print("menuitem reg ok",34,61,7)
end
